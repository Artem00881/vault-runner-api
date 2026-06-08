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

/** Pepper for the irreversible tombstone HMAC. A dedicated env wins; else the JWT secret;
 *  else a dev constant (tests / local). The pepper only needs to be stable + non-public —
 *  it makes a tombstone non-reversible without knowing it, and unlinkable across deploys
 *  that rotate it. Read at call time (not module load) so a test/CLI env always applies. */
function anonymizePepper(): string {
  return process.env.ANONYMIZE_PEPPER || process.env.JWT_SECRET || "vaultrun-anon-dev";
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
 * NO HTTP controller is wired here on purpose (the route inherits the operator VOID route's
 * prerequisites — per-operator rate limit + read-vs-write key scope, see the roadmap
 * deferred list). Service + CLI only for now.
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
}
