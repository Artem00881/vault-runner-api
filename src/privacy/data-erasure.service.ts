import { BadRequestException, Inject, Injectable, Optional } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditEventService } from "../audit/audit-event.service";
import { MetricsService } from "../metrics/metrics.service";

/**
 * NON-TERMINAL (transient / unsettled) bet statuses. A player with ANY bet in one of
 * these has money still in flight (a reservation, an owed refund/void, an open or
 * owed-but-unconfirmed win) — anonymizing them now could detach a live obligation from
 * its identity tag mid-settlement, so we refuse. The TERMINAL set is the complement:
 * cashed_out | busted | cancelled | voided (money fully settled).
 *
 * Mirrors the transient statuses the reservation/payout sweeps act on (Bet.status in
 * schema.prisma + reconcile-check.ts invariant 5: reserving|cancelling|voiding +
 * payout_pending) plus the open `active` bet of a round still in flight.
 */
const NON_TERMINAL_BET_STATUSES = [
  "reserving",
  "cancelling",
  "active",
  "payout_pending",
  "voiding",
] as const;

/** One-time guard so the JWT_SECRET-fallback warning is emitted at most once per process
 *  (the pepper is read on every anonymize/sweep call — we don't want to spam the log). */
let warnedJwtSecretFallback = false;

/** Pepper for the irreversible tombstone HMAC (R-037). Resolution order:
 *    1. ANONYMIZE_PEPPER — the dedicated, recommended secret (prod: 1Password, see DEPLOY.md §12).
 *    2. JWT_SECRET       — back-compat fallback so existing deploys / dev keep working, WITH a
 *                          one-time warning (a dedicated pepper is the correct prod posture; sharing
 *                          the JWT signing secret as the tombstone pepper couples two unrelated
 *                          secrets' rotation lifecycles — rotating JWT_SECRET would silently break
 *                          tombstone idempotency / re-resolution).
 *    3. a dev constant   — tests / local only (neither env set).
 *  The pepper only needs to be stable + non-public — it makes a tombstone non-reversible without
 *  knowing it, and unlinkable across deploys that rotate it. CRITICAL: never rotate it while
 *  tombstones are live (it would change every future tombstone, breaking idempotent re-resolution
 *  of already-anonymized players — mirrors the REPORTING_KEY_PEPPER caveat). Read at call time (not
 *  module load) so a test/CLI env always applies. */
function anonymizePepper(): string {
  if (process.env.ANONYMIZE_PEPPER) return process.env.ANONYMIZE_PEPPER;
  if (process.env.JWT_SECRET) {
    if (!warnedJwtSecretFallback) {
      warnedJwtSecretFallback = true;
      // eslint-disable-next-line no-console -- standalone-CLI-safe (this module runs without Nest DI
      // in scripts/anonymize-player.ts + scripts/retention-sweep.ts, so no injected Logger here).
      console.warn(
        "[DataErasureService] ANONYMIZE_PEPPER is unset — falling back to JWT_SECRET for the tombstone " +
          "HMAC. Set a dedicated ANONYMIZE_PEPPER (DEPLOY.md §12) before erasing real-player PII, and " +
          "NEVER rotate it while tombstones are live (rotation breaks idempotent re-resolution).",
      );
    }
    return process.env.JWT_SECRET;
  }
  return "vaultrun-anon-dev";
}

/** Irreversible, PER-USER tombstone: HMAC-SHA256(pepper, internalUserId), 24 hex chars.
 *  Used for User.username — distinct per user, so the @unique(username) constraint holds
 *  even when a player has several currency wallets. Not reversible to the operator playerId. */
function tombstone(userId: string): string {
  return createHmac("sha256", anonymizePepper()).update(userId).digest("hex").slice(0, 24);
}

/** Irreversible, PER-PLAYER tombstone: HMAC-SHA256(pepper, `${operatorId}:${playerId}`), 24
 *  hex chars. Used for GameSession.playerId. DETERMINISTIC from the (operatorId, playerId)
 *  INPUT — so a re-run recomputes the same value and can RE-FIND the already-anonymized
 *  player by its sessions (idempotency) — yet non-reversible (HMAC) and tenant-isolated
 *  (operatorId is mixed in, so operator B with the same playerId gets a different value).
 *  NB: this intentionally differs from the per-user `tombstone(userId)` on username, which
 *  must stay unique per user; resolvability lives on the session, uniqueness on the user. */
function playerTombstone(operatorId: string, playerId: string): string {
  return createHmac("sha256", anonymizePepper()).update(`${operatorId}:${playerId}`).digest("hex").slice(0, 24);
}

export interface AnonymizePlayerInput {
  operatorId: string;
  playerId: string;
  currency?: string; // narrows the human-facing meta only; resolution is by the playerId prefix across all currencies
  actor: string; // who triggered it, for the audit row ("provision-cli" | "operator:<id>" | ...)
  reason?: string;
}

export interface AnonymizePlayerResult {
  ok: true;
  alreadyAnonymized: boolean;
  usersAffected: number;
  scrubbedFields: string[];
}

/**
 * GDPR "right to erasure" as ANONYMIZATION-IN-PLACE (audit F-065), the privacy-by-design
 * complement to F-017 (money records are now RESTRICT — never cascade-deleted). Instead of
 * deleting a player (which F-017 now forbids while bets/ledger reference them, and which
 * would destroy the financial journal a lab/regulator expects retained), we SCRUB the PII
 * fields in place and leave the entire money graph — Wallet, LedgerTransaction, Bet — and
 * every FK byte-identical.
 *
 * Scope: an operator player is one or more local Users tagged `op:{operatorId}:{playerId}:
 * {currency}[:demo]` (one per currency/mode). RESOLUTION is two-pass so it works before AND
 * after anonymization: (1) LIVE users by the `op:{op}:{player}:` username PREFIX (covers every
 * currency wallet), plus (2) ALREADY-ANONYMIZED users via their sessions — a GameSession
 * whose retained operatorId + scrubbed playerId (`anon:{playerTombstone}`) match this input.
 * We then scrub:
 *   - User.username       → `anon:{tombstone(userId)}`              (drops the operator playerId; per-user-unique)
 *   - Profile.displayName → "anon"
 *   - GameSession.playerId → `anon:{playerTombstone(op,player)}`    (resolvable on re-run, non-reversible)
 *   - User.anonymizedAt   → now()                                  (tombstone marker)
 *
 * Pre-condition (fail closed): refuse if ANY bet is non-terminal OR ANY session is still
 * live (revokedAt null) — we never scrub identity off an in-flight obligation. Idempotent:
 * a second run on an already-tombstoned player resolves the same users (via pass 2), sees
 * every one already has anonymizedAt set, and is a no-op (no audit row, no mutation).
 *
 * CALLERS (all reuse this one fail-closed path): the CLI `scripts/anonymize-player.ts` (manual
 * per-player erasure); the operator-facing HTTP route `POST /api/operator/players/:playerId/erase`
 * (R-039 — tenant-scoped GDPR data-subject request, behind the write-scope gate); and the
 * retention sweep `scripts/retention-sweep.ts` (R-038 — dormant-player auto-erasure, dry-run by
 * default). None of them weaken the money-journal retention or the in-flight pre-condition.
 */
@Injectable()
export class DataErasureService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditEventService) private readonly audit: AuditEventService,
    // Optional so a bare `new DataErasureService(prisma, audit)` (CLI / unit test) compiles;
    // every call site guards with `?.`. Present when wired by Nest DI.
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
  ) {}

  async anonymizePlayer(input: AnonymizePlayerInput): Promise<AnonymizePlayerResult> {
    const prefix = `op:${input.operatorId}:${input.playerId}:`;
    const pTomb = playerTombstone(input.operatorId, input.playerId);

    // PASS 1 — LIVE users by the operator+player username PREFIX (every currency + :demo).
    const liveCandidates = await this.prisma.user.findMany({
      where: { username: { startsWith: prefix } },
      include: { wallets: { select: { id: true } }, profile: { select: { userId: true } } },
    });

    // DELIMITER-AMBIGUITY GUARD: `:` is the username field separator AND playerId is NOT
    // charset-validated at launch, so a bare `startsWith(prefix)` over-matches. For player
    // "alice" (prefix `op:OP:alice:`) the prefix is ALSO a prefix of a DIFFERENT player whose
    // username is `op:OP:alice:EUR:bob:EUR` (playerId "alice:EUR:bob") — scrubbing that would
    // erase the wrong player's PII. After stripping the exact `op:{op}:{player}:` prefix, the
    // ONLY legitimate remainder for THIS player is a bare currency optionally followed by
    // `:demo` (i.e. no further `:`): the tag shape is `op:{op}:{player}:{currency}[:demo]`.
    // Keep `op:OP:alice:EUR` and `op:OP:alice:EUR:demo`; drop `op:OP:alice:EUR:bob:EUR`.
    const SUFFIX_RE = /^[^:]+(:demo)?$/;
    const liveUsers = liveCandidates.filter((u) => SUFFIX_RE.test(u.username.slice(prefix.length)));

    // PASS 2 — ALREADY-ANONYMIZED users for THIS (operatorId, playerId). Their username no
    // longer carries the op: prefix, but their sessions retained operatorId and carry the
    // deterministic scrubbed playerId `anon:{playerTombstone}` — so we re-find them by that.
    // (This is what makes a re-run idempotent rather than a silent 0-user no-op.)
    const anonSessions = await this.prisma.gameSession.findMany({
      where: { operatorId: input.operatorId, playerId: `anon:${pTomb}` },
      select: { walletId: true },
    });
    const anonWalletIds = anonSessions.map((s) => s.walletId);
    const anonUsers = anonWalletIds.length
      ? await this.prisma.user.findMany({
          where: { wallets: { some: { id: { in: anonWalletIds } } } },
          include: { wallets: { select: { id: true } }, profile: { select: { userId: true } } },
        })
      : [];

    // Merge the two passes, de-duplicating by user id.
    const byId = new Map<string, (typeof liveUsers)[number]>();
    for (const u of [...liveUsers, ...anonUsers]) byId.set(u.id, u);
    const users = [...byId.values()];

    // Unknown player → succeed with a no-op. We do NOT throw a "not found": that would be an
    // existence oracle (a caller could probe which playerIds exist under an operator).
    if (users.length === 0) {
      return { ok: true, alreadyAnonymized: false, usersAffected: 0, scrubbedFields: [] };
    }

    const userIds = users.map((u) => u.id);
    const walletIds = users.flatMap((u) => u.wallets.map((w) => w.id));

    // Idempotency: every resolved user already tombstoned → nothing to do, no second audit row.
    if (users.every((u) => u.anonymizedAt !== null)) {
      return { ok: true, alreadyAnonymized: true, usersAffected: users.length, scrubbedFields: [] };
    }

    // Pre-condition — fail CLOSED if money is still in flight. (A) any non-terminal bet on
    // this player's wallets; (B) any still-live session (revokedAt null). Scrub NOTHING.
    if (walletIds.length > 0) {
      const inFlightBets = await this.prisma.bet.count({
        where: { walletId: { in: walletIds }, status: { in: [...NON_TERMINAL_BET_STATUSES] } },
      });
      if (inFlightBets > 0) throw new BadRequestException("player_not_settled");

      const liveSessions = await this.prisma.gameSession.count({
        where: { walletId: { in: walletIds }, revokedAt: null },
      });
      if (liveSessions > 0) throw new BadRequestException("player_not_settled");
    }

    const scrubbedFields = ["username", "displayName", "session.playerId"];
    const anonymizedAt = new Date();

    // One transaction: scrub the PII string fields + set the tombstone marker. Money columns
    // (Wallet.balance, LedgerTransaction.amount/balanceAfter, Bet.amount/payout/status, …) and
    // the entire FK graph are UNTOUCHED — only username / displayName / session.playerId /
    // anonymizedAt change. Per-user username (the unique tombstone) so the @unique holds.
    await this.prisma.$transaction([
      ...users.map((u) =>
        this.prisma.user.update({
          where: { id: u.id },
          data: { username: `anon:${tombstone(u.id)}`, anonymizedAt },
        }),
      ),
      // Profiles: scrub displayName for the resolved users that have one.
      this.prisma.profile.updateMany({
        where: { userId: { in: userIds } },
        data: { displayName: "anon" },
      }),
      // Sessions bound to this player's wallets: scrub the operator playerId to the
      // deterministic per-PLAYER tombstone (resolvable on re-run; raw playerId gone).
      this.prisma.gameSession.updateMany({
        where: { walletId: { in: walletIds } },
        data: { playerId: `anon:${pTomb}` },
      }),
    ]);

    this.metrics?.recordPlayerAnonymize();

    // Significant-event audit row (F-058), AFTER the commit, best-effort (record() never
    // throws). NEVER log the old username / playerId / displayName or any scrubbed value —
    // only WHICH fields were scrubbed + the (internal) user count. targetId = the internal
    // userId (NOT the operator playerId). No `ip` (this path is CLI / server-initiated).
    await this.audit.record({
      actor: input.actor,
      action: "player.anonymize",
      targetType: "user",
      targetId: userIds[0],
      operatorId: input.operatorId,
      before: { scrubbedFields },
      after: { anonymizedAt: anonymizedAt.toISOString(), usersAffected: users.length },
      meta: { reason: input.reason, currency: input.currency ?? "all" },
    });

    return { ok: true, alreadyAnonymized: false, usersAffected: users.length, scrubbedFields };
  }

  /**
   * R-038 retention sweep helper — enumerate the DORMANT operator players eligible for
   * retention-based erasure: those whose LAST activity is older than `cutoff` and who are not
   * already anonymized. Used ONLY by `scripts/retention-sweep.ts`; the actual scrub still goes
   * through anonymizePlayer() (which re-checks the in-flight pre-condition + retains the money
   * journal), so this method NEVER mutates anything — it is a pure read.
   *
   * "Last activity" is the MOST RECENT of (a) any GameSession.createdAt and (b) any Bet.createdAt
   * across ALL of the player's wallets. We deliberately do NOT use GameSession.lastSeenAt: it is
   * `@updatedAt` but never written (audit M-C2.2), so it is not a reliable recency signal. A
   * player with NO bets is judged by their last launch alone; a player with NO sessions at all is
   * not an operator player and is skipped (the operator+player identity lives on the session).
   *
   * Resolution is per (operatorId, playerId) — the same tenant key anonymizePlayer() consumes —
   * so the sweep can hand each result straight back to anonymizePlayer(). Demo (`:demo`) wallets
   * are INCLUDED in the recency calc (a player who only ever played demo is still erasable), but a
   * player is identified by the (operatorId, playerId) pair regardless of currency/mode.
   *
   * CONSERVATIVE by construction: a player is returned ONLY if EVERY activity signal is past the
   * cutoff. Anyone with even one recent session or bet is excluded. Already-anonymized users
   * (anonymizedAt set) are filtered out so a re-run doesn't re-list them.
   */
  async findDormantPlayers(cutoff: Date): Promise<Array<{ operatorId: string; playerId: string; lastActivity: Date }>> {
    // All operator sessions (every launch, real + demo), grouped per (operatorId, playerId). A
    // GameSession always carries the raw operatorId; the playerId is the operator-supplied id
    // BEFORE anonymization and the `anon:{tombstone}` AFTER — we filter the latter out below via
    // the user's anonymizedAt, so an already-erased player is never re-listed.
    const sessions = await this.prisma.gameSession.findMany({
      select: { operatorId: true, playerId: true, walletId: true, createdAt: true },
    });
    if (sessions.length === 0) return [];

    // Group sessions by the tenant key; track the latest session time + the wallet set per player.
    const groups = new Map<string, { operatorId: string; playerId: string; walletIds: Set<string>; lastSession: Date }>();
    for (const s of sessions) {
      const key = `${s.operatorId} ${s.playerId}`; // NUL can't appear in a UUID or a username
      const g = groups.get(key);
      if (g) {
        g.walletIds.add(s.walletId);
        if (s.createdAt > g.lastSession) g.lastSession = s.createdAt;
      } else {
        groups.set(key, { operatorId: s.operatorId, playerId: s.playerId, walletIds: new Set([s.walletId]), lastSession: s.createdAt });
      }
    }

    // Most-recent bet per wallet (one grouped query for all wallets, not an N+1).
    const allWalletIds = [...new Set(sessions.map((s) => s.walletId))];
    const lastBetByWallet = new Map<string, Date>();
    if (allWalletIds.length > 0) {
      const grouped = await this.prisma.bet.groupBy({
        by: ["walletId"],
        where: { walletId: { in: allWalletIds } },
        _max: { createdAt: true },
      });
      for (const row of grouped) {
        if (row._max.createdAt) lastBetByWallet.set(row.walletId, row._max.createdAt);
      }
    }

    // Which of these wallets belong to an ALREADY-anonymized user → drop those players entirely
    // (idempotency: a re-run must not re-list an erased player). One query for all wallets.
    const anonWallets = await this.prisma.wallet.findMany({
      where: { id: { in: allWalletIds }, user: { anonymizedAt: { not: null } } },
      select: { id: true },
    });
    const anonWalletSet = new Set(anonWallets.map((w) => w.id));

    const dormant: Array<{ operatorId: string; playerId: string; lastActivity: Date }> = [];
    for (const g of groups.values()) {
      // Skip a player ANY of whose wallets is already anonymized (the whole player is erased).
      if ([...g.walletIds].some((id) => anonWalletSet.has(id))) continue;
      // lastActivity = max(last session launch, last bet over all this player's wallets).
      let lastActivity = g.lastSession;
      for (const id of g.walletIds) {
        const b = lastBetByWallet.get(id);
        if (b && b > lastActivity) lastActivity = b;
      }
      // Conservative: dormant ONLY if the most recent signal is strictly before the cutoff.
      if (lastActivity < cutoff) dormant.push({ operatorId: g.operatorId, playerId: g.playerId, lastActivity });
    }
    // Oldest-dormant first (stable, human-friendly for the dry-run report).
    dormant.sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime());
    return dormant;
  }
}
