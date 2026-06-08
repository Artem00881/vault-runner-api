import { Injectable, Inject } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditEventService } from "../audit/audit-event.service";
import { LaunchTokenService } from "./launch-token.service";
import { LedgerService } from "../wallet/ledger.service";
import type { OperatorSession, SessionResolver } from "../wallet/seamless-operator-wallet";
import { effectiveLimitsFor, serializeBetLimits } from "./bet-limits";
import { effectiveRgFor, serializeRg } from "./rg-config";
import { currencyMeta } from "../common/currency";

// Operator session ("play") tokens are SHORT-lived (re-launch to refresh), unlike
// 30-day guest tokens — this limits how long a leaked session token is usable, and the
// sessionId is re-validated against a live GameSession at WS connect (audit L-C2.2).
// Env-tunable but CLAMPED to 60s..24h so neither a too-low nor an absurdly-high
// (control-weakening) value can take effect; out-of-range/non-numeric → default 4h.
const SESSION_TOKEN_TTL_SEC = (() => {
  const n = Number(process.env.SESSION_TOKEN_TTL_SEC);
  return Number.isFinite(n) && n >= 60 && n <= 86400 ? n : 14400;
})();

// Play-money bankroll seeded onto a demo ("fun mode") wallet on EACH launch
// (reset-to-full). Integer MINOR units; env-tunable, clamped to >= 0 — a negative
// or non-numeric value falls back to 10000 (e.g. 100.00 in a 2-dp currency).
const DEMO_STARTING_BALANCE = (() => {
  const n = Number(process.env.DEMO_STARTING_BALANCE);
  return Number.isInteger(n) && n >= 0 ? BigInt(n) : 10000n;
})();

/**
 * Turns a verified launch token into a live game session, and resolves a local
 * walletId back to the operator-side session for the SeamlessOperatorWallet.
 *
 * In operator (real-money) mode the OPERATOR's wallet is the source of truth;
 * the local wallet here is just a journal anchor (balance not authoritative —
 * the provider reads the real balance from the operator). One operator player +
 * currency reuses the same local wallet across launches.
 */
@Injectable()
export class GameSessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LaunchTokenService) private readonly launch: LaunchTokenService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(AuditEventService) private readonly audit: AuditEventService,
  ) {}

  /** Open the game from an operator launch token → create (consume) a session. */
  async openFromToken(token: string) {
    const v = await this.launch.verify(token); // signature + expiry + jti unused

    // Canonical currency (ISO-4217 uppercase) so the journal wallet key, session,
    // and per-currency bet-limit lookup are all consistent regardless of the casing
    // the operator sent (verify()'s allow-list check is likewise case-insensitive).
    const currency = (v.currency ?? "").toUpperCase();
    // A demo ("fun mode") launch plays with play money: the launch token carries an
    // operator-signed `demo` flag, its wallet is a SEPARATE journal the router always
    // settles on the internal ledger (never the operator), and it's funded to a fixed
    // play-money bankroll on each launch (Phase 3).
    const demo = v.demo === true;

    // The operator's per-currency PER-BET limits for this session's currency
    // (Phase 3). null → the player plays under the global house defaults.
    const op = await this.prisma.operator.findUnique({
      where: { id: v.operatorId },
      select: { betLimits: true, rgConfig: true, callbackUrl: true },
    });
    const limits = effectiveLimitsFor(op?.betLimits, currency);
    // Responsible-gambling config for this session (Phase 3). DEMO sessions skip RG
    // entirely (play money can't cause gambling harm) — resolving to null here means
    // no `rg` claim is ever minted onto a demo token (defense-in-depth layer 1; the
    // bet path re-checks `demo` as layer 2). null → no in-session RG controls.
    const rg = demo ? null : effectiveRgFor(op?.rgConfig, currency);

    // Find or create the local journal wallet for this operator player+currency.
    // We tag the User.username with operator+player so it's unique & traceable; a
    // demo session gets its OWN `:demo` wallet so play money never mixes with real.
    const tag = demo
      ? `op:${v.operatorId}:${v.playerId}:${currency}:demo`
      : `op:${v.operatorId}:${v.playerId}:${currency}`;
    let wallet = await this.prisma.wallet.findFirst({
      where: { currency, user: { username: tag } },
    });
    if (!wallet) {
      try {
        const user = await this.prisma.user.create({
          data: {
            id: randomUUID(),
            username: tag,
            isGuest: false,
            wallets: { create: { currency, balance: 0n } }, // journal anchor
            profile: { create: { displayName: `Player ${v.playerId.slice(0, 6)}` } },
          },
          include: { wallets: true },
        });
        wallet = user.wallets[0];
      } catch (e) {
        // Concurrent FIRST launch for this player won the race and created the
        // user+wallet (username is UNIQUE) — re-find it instead of 500-ing the
        // second launch (audit L-C2.1: concurrent first-launch is idempotent).
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          wallet = await this.prisma.wallet.findFirstOrThrow({
            where: { currency, user: { username: tag } },
          });
        } else {
          throw e;
        }
      }
    }

    // Consume the jti by recording the session (unique launchJti enforces
    // one-time use; a replayed token hits the unique constraint).
    const session = await this.prisma.gameSession.create({
      data: {
        operatorId: v.operatorId,
        playerId: v.playerId,
        currency,
        locale: v.locale,
        walletId: wallet.id,
        demo,
        launchJti: v.jti,
      },
    });

    // Demo (fun-mode) wallet: reset to the FULL play-money bankroll on EACH launch
    // (operator chose reset-on-relaunch). Idempotent per launch via the unique
    // sessionId key — a retried open is a no-op; a NEW launch tops back up to full.
    // Goes straight to the internal ledger (never the operator), safe by
    // construction since a demo wallet is always ledger-backed.
    if (demo) {
      await this.ledger.resetTo(wallet.id, DEMO_STARTING_BALANCE, `demo:reset:${session.id}`, {
        refType: "demo_reset",
        refId: wallet.id,
      });
    }

    // Issue a SESSION ("play") token the client uses for the WebSocket handshake
    // — signed with OUR JWT_SECRET (same as a guest token) so the gateway
    // verifies it identically. `sub` is the LOCAL user id (the socket/bet
    // identity); the bet path resolves THIS user's own wallet (its currency),
    // and in operator mode money routes to the operator via resolver() below.
    const playToken = await this.jwt.signAsync(
      {
        sub: wallet.userId,
        walletId: wallet.id, // the session's bound wallet — placeBet resolves THIS one (audit M-C2.1)
        currency,
        operatorId: v.operatorId,
        playerId: v.playerId,
        sessionId: session.id,
        kind: "operator",
        // Session START (epoch ms) — the authoritative immutable GameSession.createdAt.
        // Lets the gateway compute elapsed time + the RG accounting `createdAt >=` bound
        // with no DB read. Always present for operator sessions (Phase 3 — RG).
        sessionStartedAt: session.createdAt.getTime(),
        // Phase 3: the session's resolved per-currency bet limits ride with the play
        // token so the gateway applies them on every bet with no extra lookup.
        // Absent → the bet path falls back to the global house defaults.
        ...(limits ? { limits: serializeBetLimits(limits) } : {}),
        // play-money fun-mode marker the gateway stamps on the bet row. NB: the
        // actual money routing is by walletId in the WalletRouter, not this claim —
        // a forged claim can at worst mislabel a bet, never cross play/real money.
        ...(demo ? { demo: true } : {}),
        // Phase 3 RG: the session's resolved responsible-gambling controls ride the
        // SIGNED play token (un-forgeable, can't be stripped without breaking the sig).
        // Absent → no in-session RG (back-compat; demo sessions never carry it).
        ...(rg ? { rg: serializeRg(rg) } : {}),
      },
      { expiresIn: SESSION_TOKEN_TTL_SEC }, // short-lived session token (audit L-C2.2)
    );

    return {
      token: playToken,
      sessionId: session.id,
      walletId: wallet.id,
      currency,
      // Phase 3.6: the currency's decimal precision so the embedding client renders the
      // wallet (minor units) correctly from first paint, without a /api/currencies call.
      decimals: currencyMeta(currency).decimals,
      locale: v.locale,
      // Phase 3 go-live: the operator's return-to-lobby URL (null if unset) so the client
      // knows where to send the player on exit.
      callbackUrl: op?.callbackUrl ?? null,
    };
  }

  /**
   * Is this session id still a live GameSession? The WebSocket gateway calls this at
   * connect for an operator session token, so a revoked/removed session is rejected
   * even though the (short-lived) JWT itself may not yet have expired (audit L-C2.2).
   */
  async isLive(sessionId: string): Promise<boolean> {
    return (await this.prisma.gameSession.count({ where: { id: sessionId, revokedAt: null } })) > 0;
  }

  /**
   * F-068 — BATCH liveness check for the RG sweep: of the given session ids, return the set
   * that are NO LONGER live (revoked OR removed). One query for all connected operator
   * sockets (NOT one-per-socket) so the sweep can disconnect dead sessions without an N+1.
   * A session id that has no row at all is treated as not-live (the row was deleted out from
   * under the socket — also a reason to drop it). Empty input → empty set (no query).
   */
  async findNotLive(sessionIds: string[]): Promise<Set<string>> {
    if (sessionIds.length === 0) return new Set();
    const live = await this.prisma.gameSession.findMany({
      where: { id: { in: sessionIds }, revokedAt: null },
      select: { id: true },
    });
    const liveSet = new Set(live.map((s) => s.id));
    return new Set(sessionIds.filter((id) => !liveSet.has(id)));
  }

  /**
   * F-067 — a reality check just FIRED for this session (became "awaiting ack"): persist the
   * pending marker + the advanced due time so the hard-pause SURVIVES a reconnect (the gateway
   * sweep computes the next due-from-now; we record it). Best-effort — the in-memory rgPending
   * is the live gate, this persistence is what a reconnect reloads. `null` due is tolerated
   * (a configless edge) but normally always set. Failure is logged by the caller, never thrown.
   */
  async markRealityCheckPending(sessionId: string, nextDueAt: number | undefined): Promise<void> {
    await this.prisma.gameSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: {
        realityCheckPendingAt: new Date(),
        ...(nextDueAt !== undefined ? { realityCheckDueAt: new Date(nextDueAt) } : {}),
      },
    });
  }

  /**
   * F-067 — the player ACKNOWLEDGED a reality check: clear the pending marker (lifts the
   * hard-pause), stamp the ack time, and advance the persisted due time to now + interval so a
   * reconnect resumes the SAME schedule rather than resetting to a fresh full interval. The
   * pause is cleared ONLY here (never on connect) so a reconnect can't dodge a pending check.
   */
  async ackRealityCheck(sessionId: string, nextDueAt: number | undefined): Promise<void> {
    await this.prisma.gameSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: {
        realityCheckPendingAt: null,
        realityCheckLastAckAt: new Date(),
        ...(nextDueAt !== undefined ? { realityCheckDueAt: new Date(nextDueAt) } : {}),
      },
    });
  }

  /**
   * F-067 — reload the persisted reality-check state at (re)connect so the hard-pause and the
   * due-clock survive a reconnect. Returns:
   *   - pending: realityCheckPendingAt != null → the gateway re-arms rgPending (place_bet stays
   *     blocked until ack — the pause is NOT cleared on connect, only by ack);
   *   - dueAt: the persisted next-check epoch (ms), or undefined for a brand-new session with no
   *     persisted due time (the gateway then falls back to the token-derived due time).
   * A guest / missing row → { pending:false } (no RG state to restore).
   */
  async loadRealityCheckState(sessionId: string): Promise<{ pending: boolean; dueAt?: number }> {
    const s = await this.prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: { realityCheckPendingAt: true, realityCheckDueAt: true },
    });
    if (!s) return { pending: false };
    return {
      pending: s.realityCheckPendingAt != null,
      dueAt: s.realityCheckDueAt != null ? s.realityCheckDueAt.getTime() : undefined,
    };
  }

  /**
   * F-068 — OPERATOR-AUTHED "terminate active session(s)" for one of the operator's OWN
   * players. Resolves the operator's local journal wallet(s) for that player by the immutable
   * username TAG (`op:{operatorId}:{playerId}:` — the same key openFromToken mints, also used by
   * the H4 anonymize resolver) and soft-revokes via the EXISTING revokeForWallet (which sets
   * revokedAt + writes the H2 `session.revoke` audit row). TENANT-SCOPED by construction: the
   * tag is prefixed with the AUTHENTICATED operatorId (from OperatorAuthGuard, never the body),
   * so an operator can revoke ONLY its own players — a wallet under another operator's prefix is
   * never matched. Optional `currency` narrows to one currency's wallet(s) (real + demo); absent
   * → all of the player's wallets for this operator. Returns sessions revoked + wallets touched.
   */
  async revokeForOperatorPlayer(
    operatorId: string,
    playerId: string,
    currency?: string,
  ): Promise<{ revoked: number; wallets: number }> {
    // The tag openFromToken builds is `op:{operatorId}:{playerId}:{currency}` (real) or
    // `op:{operatorId}:{playerId}:{currency}:demo` (demo). Without a currency, match the
    // operator+player prefix (trailing colon prevents `player-1` matching `player-12`) so
    // BOTH the real and demo wallets across all of this player's currencies are covered.
    // WITH a currency, match EXACTLY the real tag and the demo tag for that currency — NOT a
    // loose `…:EUR` prefix, which would also match a different currency `…:EURX` (over-revoke).
    const base = `op:${operatorId}:${playerId}:`;
    const where = currency
      ? { user: { username: { in: [`${base}${currency.toUpperCase()}`, `${base}${currency.toUpperCase()}:demo`] } } }
      : { user: { username: { startsWith: base } } };
    const candidates = await this.prisma.wallet.findMany({
      where,
      select: { id: true, user: { select: { username: true } } },
    });
    // Guard the no-currency `startsWith` branch against a colon-bearing `playerId` over-matching a
    // SIBLING player of the SAME operator (e.g. playerId "alice" prefix-matching "alice:x:bob",
    // username `op:{op}:alice:x:bob:EUR`) — the same over-match class fixed in the H4 anonymize
    // resolver. `playerId` is operator-supplied + not charset-validated, so keep ONLY wallets whose
    // tag suffix (after the `op:{op}:{player}:` prefix) is a bare currency (optionally `:demo`) with
    // no further ':'. The currency branch is an exact `in` match, so this filter is a no-op there.
    const SUFFIX_RE = /^[^:]+(:demo)?$/;
    const wallets = candidates.filter((w) =>
      SUFFIX_RE.test((w.user?.username ?? "").slice(base.length)),
    );
    let revoked = 0;
    for (const w of wallets) {
      revoked += await this.revokeForWallet(w.id);
    }
    return { revoked, wallets: wallets.length };
  }

  /**
   * Soft-revoke every live session bound to this wallet — the L-C2.2 revocation TRIGGER
   * (e.g. a player logout). Sets `revokedAt` so `isLive()` rejects the session at WS
   * connect; the rows are KEPT so the operator-wallet resolver still serves any in-flight
   * settlement for that wallet. Idempotent (already-revoked rows are skipped via the
   * `revokedAt: null` filter). Returns how many sessions were revoked.
   */
  async revokeForWallet(walletId: string): Promise<number> {
    // Capture the live sessions about to be revoked (id + operatorId) for the audit log
    // BEFORE the update flips revokedAt; this read does not change the revoke semantics.
    const targets = await this.prisma.gameSession.findMany({
      where: { walletId, revokedAt: null },
      select: { id: true, operatorId: true },
    });
    const r = await this.prisma.gameSession.updateMany({
      where: { walletId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Significant-event audit log (F-058) — only when something was actually revoked, so
    // the idempotent already-revoked no-op doesn't spam the log. Best-effort (never throws).
    if (r.count > 0) {
      await this.audit.record({
        actor: "system",
        action: "session.revoke",
        targetType: "game_session",
        targetId: walletId,
        operatorId: targets[0]?.operatorId,
        after: { revokedAt: new Date().toISOString() },
        meta: { walletId, revokedCount: r.count, sessionIds: targets.map((t) => t.id) },
      });
    }
    return r.count;
  }

  /**
   * Is the wallet bound to this walletId a DEMO ("fun mode") play-money wallet?
   * The WalletRouter calls this on EVERY money move to settle demo sessions on the
   * internal ledger and real sessions on the operator. A wallet's mode is fixed for
   * its lifetime (a demo wallet is a distinct journal under a `:demo` tag), so ANY
   * session for the walletId is authoritative — no ordering needed.
   *
   * Classification:
   *  - a session with demo=true  → TRUE  (route to the ledger);
   *  - a session with demo=false → FALSE (route to the operator);
   *  - NO session → fall back to the immutable wallet TAG: a real operator wallet is
   *    `op:{op}:{player}:{ccy}` (no `:demo`) → FALSE; a guest (`Thief_…`) / demo-tagged
   *    / unknown wallet → TRUE (play money). A real operator wallet normally ALWAYS has
   *    a session; the only way it reaches here is if the session was deleted out from
   *    under an owed bet (e.g. an operator hard-deleted while a payout was still pending
   *    — the cascade nukes the session). Classifying it FALSE keeps a REAL obligation
   *    from silently settling on the play-money ledger; the operator path then fails
   *    closed (its resolver throws → payout stays pending, loudly retried) instead.
   *
   * A genuine lookup ERROR is deliberately NOT swallowed — it PROPAGATES so the money
   * move fails CLOSED into the existing recovery machinery (a credit → payout_pending
   * → reconciler; a debit → reservation released) rather than fail-OPEN, which would
   * silently credit the play-money ledger for a REAL payout and lose it (money-path
   * audit HIGH). Either way an unsure call NEVER reaches the operator's real wallet.
   */
  async isDemoWallet(walletId: string): Promise<boolean> {
    const s = await this.prisma.gameSession.findFirst({
      where: { walletId },
      select: { demo: true },
    });
    if (s) return s.demo;
    // No session → distinguish a real operator wallet (whose session vanished) from a
    // genuine play-money wallet (guest / demo) by the immutable username tag, so a real
    // owed payout can't be silently routed to the play-money ledger.
    const w = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      select: { user: { select: { username: true } } },
    });
    const name = w?.user?.username ?? "";
    const isRealOperatorWallet = name.startsWith("op:") && !name.endsWith(":demo");
    return !isRealOperatorWallet;
  }

  /**
   * SessionResolver for SeamlessOperatorWallet: walletId → operator session.
   * Every GameSession for a given walletId shares the SAME (operatorId,
   * playerId, currency) by construction (the wallet is keyed to one operator
   * player+currency), so any session yields identical routing — we take the
   * most recent by createdAt. (NB: GameSession.lastSeenAt is @updatedAt but is
   * never written, so it must NOT be used to order — audit M-C2.2.)
   */
  resolver(): SessionResolver {
    return async (walletId: string): Promise<OperatorSession> => {
      const session = await this.prisma.gameSession.findFirstOrThrow({
        where: { walletId },
        orderBy: { createdAt: "desc" },
      });
      return {
        operatorId: session.operatorId,
        playerId: session.playerId,
        currency: session.currency,
      };
    };
  }
}
