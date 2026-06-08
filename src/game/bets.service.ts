import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WALLET_PROVIDER, type WalletProvider, type WalletTxResult } from "../wallet/wallet-provider";
import { GameEngineService } from "./game-engine.service";
import { RiskService, type PerBetLimits } from "./risk.service";
import { MetricsService } from "../metrics/metrics.service";
import type { EffectiveRg } from "../operator/rg-config";
import { isWageredStatus, isWonStatus } from "../common/bet-status";
import { floorPayout } from "../common/money";

export type Panel = "A" | "B";

/** Per-bet operator context (Phase 3.5). Denormalised onto the Bet row for per-operator
 *  reporting. Sourced from the verified play token (operatorId); guests carry none. */
export interface BetOperatorContext {
  operatorId?: string;
}

/** Per-session responsible-gambling context for a bet (Phase 3). Real-money sessions
 *  only — demo/guests carry none. The gateway resolves it from the signed play token
 *  (`rg` claim + `sessionStartedAt`) + the live per-socket reality-check pending flag. */
export interface RgContext {
  rg?: EffectiveRg;
  rgPending?: boolean; // a reality check is awaiting acknowledgment (blocks NEW bets)
  sessionStartedAt?: number; // epoch ms (GameSession.createdAt) — accounting window + time limit
}

export interface BetResult {
  ok: boolean;
  reason?: string;
  panel: Panel;
  balance?: number;
  betId?: string;
  currency?: string;
}
export interface CashoutResult {
  ok: boolean;
  reason?: string;
  userId?: string;
  panel: Panel;
  multiplier?: number;
  payout?: number;
  balance?: number;
  currency?: string;
  /** operator-mode: the win is recorded but not yet confirmed (H2 reconciler). */
  pending?: boolean;
}

/** Result of an operator-initiated VOID (Phase 6). Money as minor-unit strings.
 *  `refundedStake`/`reclaimedPayout` describe the bet's VOID OUTCOME (lifetime), not
 *  necessarily what THIS call moved — check `reversed` to know if this call did the work
 *  (an idempotent re-void returns `reversed:false` with the same outcome figures). */
export interface VoidResult {
  ok: boolean;
  betId: string;
  status: string; // final bet status (voided | cancelled)
  reversed: boolean; // true if THIS call performed the reversal (false = already net-zero before this call)
  refundedStake: string; // minor units returned to the player (the stake)
  reclaimedPayout: string; // minor units reclaimed from the player (0 if the bet wasn't a win)
}

/**
 * All money-moving bet operations, validated against the authoritative engine
 * (server clock decides phase) and applied through the idempotent ledger.
 */
// A payout_pending bet older than this (seconds) is "stuck" — log it loudly so
// it's visible/alertable. We NEVER abandon a won payout; this only escalates
// noise, the reconciler keeps retrying forever. Env-tunable (H2 operability).
const PAYOUT_PENDING_ALERT_SEC = Number(process.env.PAYOUT_PENDING_ALERT_SEC ?? 3600);
// A reserving|cancelling slot older than this (seconds) is "stuck" — an owed refund the
// sweep hasn't cleared (e.g. a cancelling slot whose reversal keeps failing). Log it
// loudly; the sweep keeps retrying forever. Env-tunable (audit Low-4).
const RESERVING_ALERT_SEC = Number(process.env.RESERVING_ALERT_SEC ?? 600);

/** A session token's walletId that doesn't belong to its authenticated user (sub).
 *  Should never happen (we mint them coherently) — surfaced as a DISTINCT rejected
 *  metric so a cross-user probe pattern is alertable, not buried in bet_failed (L-2). */
class WalletOwnershipError extends Error {
  constructor(walletId: string, userId: string) {
    super(`wallet ${walletId} does not belong to user ${userId}`);
  }
}

@Injectable()
export class BetsService {
  private readonly log = new Logger(BetsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    // talks to the active WalletProvider (internal ledger today; operator wallet
    // later) — not LedgerService directly, so the money source can be swapped.
    @Inject(WALLET_PROVIDER) private readonly wallet$: WalletProvider,
    @Inject(GameEngineService) private readonly engine: GameEngineService,
    @Inject(RiskService) private readonly risk: RiskService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  // Resolve the wallet for a NEW bet. Prefer the EXACT walletId the session bound at
  // launch (audit M-C2.1) so this is robust even if a user ever holds more than one
  // wallet (multi-currency): findFirst would otherwise pick an arbitrary one. The
  // session walletId comes from OUR signed token, but `sub` (the userId) stays the
  // money trust anchor — verify the wallet belongs to this user so a stale/mismatched
  // claim can never place a bet on another user's wallet. Without a session walletId
  // (a guest), fall back to the user's single wallet (one-per-user by construction).
  private async wallet(userId: string, walletId?: string) {
    if (walletId) {
      const w = await this.prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
      if (w.userId !== userId) throw new WalletOwnershipError(walletId, userId);
      return w;
    }
    return this.prisma.wallet.findFirstOrThrow({ where: { userId } });
  }

  /**
   * Per-session money totals for responsible-gambling limits, DERIVED from Bet rows
   * (no running counters → no double-count hazard, always ledger-consistent). Scoped
   * to this session: the bound walletId AND createdAt >= the session start (the wallet
   * is reused across launches, so the time bound is what makes it per-session). Served
   * by the `[walletId, createdAt]` index.
   *
   *  - wagered = Σ stake over bets whose stake was actually DEBITED
   *              (active | cashed_out | busted | payout_pending);
   *              EXCLUDES reserving (pre-debit) and cancelling/cancelled (refunded).
   *  - won     = Σ payout over settled wins (cashed_out | payout_pending — a
   *              payout_pending is an owed, already-claimed win).
   *  - net     = wagered − won (positive = the player is down). An UNSETTLED active
   *              stake counts fully toward wagered with payout 0, i.e. as at-risk loss
   *              — the protective direction so a loss cap can't be dodged by leaving
   *              bets open.
   */
  async sessionAccounting(
    walletId: string,
    since: Date,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{ wagered: bigint; won: bigint; net: bigint }> {
    // `db` defaults to the shared client; the RG HARD cap passes the reserve `tx` so the
    // read is a consistent snapshot under the per-round lock.
    const bets = await db.bet.findMany({
      where: { walletId, createdAt: { gte: since } },
      select: { status: true, amount: true, payout: true },
    });
    let wagered = 0n;
    let won = 0n;
    for (const b of bets) {
      // Shared status sets (common/bet-status) so RG accounting and operator reporting
      // use one money definition and can never drift.
      if (isWageredStatus(b.status)) wagered += b.amount;
      if (isWonStatus(b.status)) won += b.payout;
    }
    return { wagered, won, net: wagered - won };
  }

  /** Place a bet on the CURRENT round during the betting window. */
  async placeBet(userId: string, panel: Panel, amount: number, autoCashout?: number, walletId?: string, limits?: PerBetLimits, demo?: boolean, rgCtx?: RgContext, betCtx?: BetOperatorContext): Promise<BetResult> {
    const state = this.engine.getPublicState();
    if (!state || state.phase !== "betting") return { ok: false, reason: "betting_closed", panel };

    const amt = BigInt(Math.floor(amount));
    // Per-currency min/max stake (operator config) or the global defaults (no limits).
    const amtCheck = this.risk.checkBetAmount(amt, limits);
    if (!amtCheck.ok) { this.metrics.recordRejected(amtCheck.reason); return { ok: false, reason: amtCheck.reason, panel }; }

    // Phase 3 — RESPONSIBLE-GAMBLING (real-money sessions only; DEMO & guests skip).
    // The `demo` re-check here is defense-in-depth: no `rg` claim is ever minted onto a
    // demo token, but a play-money bet must never be RG-blocked even if one somehow were.
    // RG only gates NEW bets (placeBet) — cash-out/cancel are NEVER blocked, so an
    // at-risk player can always get their money out. Cheap (no-DB) checks first.
    const rg = !demo && rgCtx?.rg && rgCtx.sessionStartedAt ? rgCtx.rg : undefined;
    if (rg) {
      // Reality check awaiting acknowledgment (hard-pause mode) → block new bets until ack.
      if (rg.enforceRealityCheck && rgCtx!.rgPending) {
        this.metrics.recordRejected("reality_check_pending");
        this.metrics.recordRgBlock("reality_check_pending");
        return { ok: false, reason: "reality_check_pending", panel };
      }
      // Max session duration reached (belt-and-suspenders with the gateway sweep).
      if (rg.maxSessionSec !== undefined && Date.now() >= rgCtx!.sessionStartedAt! + rg.maxSessionSec * 1000) {
        this.metrics.recordRejected("session_time_limit");
        this.metrics.recordRgBlock("session_time_limit");
        return { ok: false, reason: "session_time_limit", panel };
      }
    }

    const roundId = state.roundId;
    const existing = await this.prisma.bet.findUnique({
      where: { roundId_userId_panel: { roundId, userId, panel } },
    });
    // A non-'reserving' row = a real prior bet → reject. A 'reserving' row may be a
    // concurrent in-flight attempt or one whose debit is failing (about to be
    // released) — don't hard-reject a retry here; the in-lock unique insert (P2002)
    // is the authoritative dedup (audit H1 review).
    if (existing && existing.status !== "reserving") return { ok: false, reason: "already_bet", panel };

    const wallet = await this.wallet(userId, walletId).catch((e: any) => {
      this.log.warn(`placeBet wallet resolution failed for user ${userId}: ${e?.message}`);
      // Distinct label for a cross-user/mismatched walletId so it's alertable (L-2);
      // the client still sees a generic bet_failed (no info leak).
      this.metrics.recordRejected(e instanceof WalletOwnershipError ? "wallet_owner_mismatch" : "bet_failed");
      return null;
    });
    if (!wallet) return { ok: false, reason: "bet_failed", panel };

    // NOTE: the RG loss/wager-cap projection moved INSIDE the reserve lock below (a HARD
    // cap — go-live hardening). All of a session's concurrent bets are on the current
    // round, so they share the per-round advisory lock → serialized there, closing the
    // soft-cap TOCTOU. (The cheap reality-check/time-limit checks stay pre-lock above.)

    const betId = randomUUID();

    // PHASE 1 — RESERVE (audit H1). Serialize all placeBet for THIS round on a
    // per-round advisory lock so the exposure check + the reservation are atomic:
    // concurrent bets can no longer all read the same low exposure and collectively
    // blow past the bankroll cap. We insert a "reserving" slot (not yet debited) and
    // release the lock at tx end — we do NOT hold it across the debit (a slow
    // operator-wallet call must never freeze the whole round's betting window).
    let rejectReason: string | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${roundId}))`;
        const roundBets = await tx.bet.findMany({
          where: { roundId, status: { in: ["active", "reserving"] } },
          select: { amount: true, walletId: true, status: true },
        });
        const currentExposure = roundBets.reduce((sum, b) => sum + this.risk.potentialPayout(b.amount), 0n);
        const expCheck = this.risk.checkRoundExposure(currentExposure, amt);
        if (!expCheck.ok) { rejectReason = expCheck.reason; throw new Error("reserve_rejected"); }

        // RG loss/wager HARD cap (real-money sessions only; demo/guests have no `rg`).
        // Evaluated INSIDE the lock so concurrent same-session bets serialize here. SAFETY
        // DEPENDS on the per-round advisory lock above (not snapshot isolation, which is
        // READ COMMITTED) — do not remove it or the TOCTOU returns.
        // sessionAccounting gives the committed (active/settled) session total; the
        // in-flight `reserving` part is derived from the SAME roundBets read above —
        // NOT a separate walletId query, which under Bun/Prisma can intermittently miss
        // a just-committed concurrent reserving row that the roundId read reliably sees.
        // All of a session's concurrent bets are on THIS round (one betting window), so
        // the current-round reserving rows are the complete in-flight set (and stale
        // prior-round reserving dust is correctly NOT counted). THIS bet's own row isn't
        // inserted yet → `amt` added explicitly (no double count). Inclusive boundary.
        if (rg && (rg.maxSessionLoss !== undefined || rg.maxSessionWager !== undefined)) {
          const acc = await this.sessionAccounting(wallet.id, new Date(rgCtx!.sessionStartedAt!), tx);
          const reserved = roundBets
            .filter((b) => b.walletId === wallet.id && b.status === "reserving")
            .reduce((sum, b) => sum + b.amount, 0n);
          if (rg.maxSessionWager !== undefined && acc.wagered + reserved + amt > rg.maxSessionWager) {
            this.metrics.recordRgBlock("session_wager_limit");
            rejectReason = "session_wager_limit"; throw new Error("reserve_rejected");
          }
          // A reserving stake is at-risk loss in waiting (same protective direction as an
          // unsettled active stake) → add to net.
          if (rg.maxSessionLoss !== undefined && acc.net + reserved + amt > rg.maxSessionLoss) {
            this.metrics.recordRgBlock("session_loss_limit");
            rejectReason = "session_loss_limit"; throw new Error("reserve_rejected");
          }
        }

        await tx.bet.create({
          data: {
            id: betId,
            roundId,
            userId,
            walletId: wallet.id,
            panel,
            amount: amt,
            autoCashout: autoCashout ?? null,
            status: "reserving",
            // Descriptive audit stamp: was this a play-money (fun-mode) bet? The money
            // ROUTING is by walletId in the WalletRouter, not this flag (Phase 3).
            demo: demo ?? false,
            // Denormalise the operator + currency for per-operator REPORTING (Phase 3.5).
            // operatorId comes from the verified play token (null for guests/internal play
            // → excluded from operator reports). currency is the wallet's canonical code.
            operatorId: betCtx?.operatorId ?? null,
            currency: wallet.currency.toUpperCase(),
            // Stamp THIS bet's per-currency win cap so cash-out (incl. server-driven
            // auto-cashout, which has no socket) caps to the same value (Phase 3).
            maxWinPerBet: limits?.maxWinPerBet ?? null,
          },
        });
      });
    } catch (e: any) {
      if (rejectReason) { this.metrics.recordRejected(rejectReason); return { ok: false, reason: rejectReason, panel }; }
      // Lost a concurrent race for the same (round,user,panel) — the slot exists.
      if (e?.code === "P2002") return { ok: false, reason: "already_bet", panel };
      this.metrics.recordRejected("bet_failed");
      return { ok: false, reason: "bet_failed", panel };
    }

    // PHASE 2 — DEBIT (outside the lock). Idempotency key is bound to the LOGICAL
    // bet (round+user+panel), not the per-attempt id, so a concurrent/retried
    // duplicate dedups in the ledger instead of charging twice (audit C1).
    const debitKey = `bet:${roundId}:${userId}:${panel}:debit`;
    let tx: WalletTxResult;
    try {
      tx = await this.wallet$.debit(wallet.id, amt, "bet_debit", debitKey, {
        refType: "bet",
        refId: betId,
      });
    } catch (e: any) {
      // Debit FAILED → NO money moved → release the reservation (drop the slot so
      // its exposure is freed for other bets).
      await this.prisma.bet.delete({ where: { id: betId } }).catch(() => {});
      const reason = e?.message === "insufficient_balance" ? "insufficient_balance" : "bet_failed";
      this.metrics.recordRejected(reason);
      return { ok: false, reason, panel };
    }

    // Debit SUCCEEDED (money moved). Activate the slot — and NEVER delete on a
    // failure here, or we'd strand a real debit (money out, no bet). Retry the
    // local flip; if it persistently fails, stamp the txId best-effort and leave
    // the row RECOVERABLE — boot recovery refunds a 'reserving' bet that carries a
    // ledger debit (audit H1 review: don't destroy a paid bet).
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Flip is a compare-and-swap on 'reserving' (mirrors the cashOut claim, audit M1).
        // If recovery reclaimed this slot concurrently (a stranded-sweep flipped it out of
        // 'reserving' → 'cancelling'), count===0 — DON'T leave a phantom active bet; recovery
        // reverses the debit. (Unreachable under the age gate; defense-in-depth for
        // operator/scale, audit Low-1.)
        const flip = await this.prisma.bet.updateMany({
          where: { id: betId, status: "reserving" },
          data: { status: "active", debitTxId: tx.id },
        });
        if (flip.count === 0) {
          this.metrics.recordError("bet_activate");
          this.log.warn(`bet ${betId} reclaimed by recovery during activation — reporting failed (debit reversed by recovery)`);
          return { ok: false, reason: "bet_failed", panel };
        }
        this.metrics.recordBet(Number(amt)); // stake → realized-RTP denominator
        return { ok: true, panel, balance: Number(tx.balanceAfter), betId, currency: wallet.currency };
      } catch (e: any) {
        if (attempt >= 3) {
          // Transient DB failure flipping the row — stamp the txId best-effort (only while
          // still 'reserving') and leave the row recoverable for the refund (audit H1).
          await this.prisma.bet
            .updateMany({ where: { id: betId, status: "reserving" }, data: { debitTxId: tx.id } })
            .catch(() => {});
          this.metrics.recordError("bet_activate");
          this.log.error(`bet ${betId} debited (tx ${tx.id}) but activation failed — left recoverable for refund`);
          return { ok: false, reason: "bet_failed", panel };
        }
      }
    }
    return { ok: false, reason: "bet_failed", panel }; // unreachable (loop returns)
  }

  /** Cancel an active bet before the round starts (refund). */
  async cancelBet(userId: string, panel: Panel): Promise<BetResult> {
    const state = this.engine.getPublicState();
    if (!state || state.phase !== "betting") return { ok: false, reason: "betting_closed", panel };
    const bet = await this.prisma.bet.findUnique({
      where: { roundId_userId_panel: { roundId: state.roundId, userId, panel } },
      include: { wallet: { select: { currency: true } } },
    });
    if (!bet || bet.status !== "active") return { ok: false, reason: "no_active_bet", panel };

    const refund = await this.wallet$.credit(bet.walletId, bet.amount, "refund", `bet:${bet.id}:refund`, {
      refType: "bet",
      refId: bet.id,
    });
    await this.prisma.bet.update({ where: { id: bet.id }, data: { status: "cancelled", settledAt: new Date() } });
    return { ok: true, panel, balance: Number(refund.balanceAfter), currency: bet.wallet.currency };
  }

  /**
   * Cash out an active bet. `atMultiplier` is used for server-side auto-cashout
   * (pays at the exact target); manual cash-outs pay at the live multiplier.
   */
  async cashOut(userId: string, panel: Panel, atMultiplier?: number): Promise<CashoutResult> {
    const t0 = Date.now(); // metrics-only: settlement-latency start (Phase 4.4)
    const state = this.engine.getPublicState();
    if (!state || state.phase !== "running") return { ok: false, reason: "too_late", userId, panel };

    const mult = atMultiplier ?? this.engine.currentMultiplier();
    const bet = await this.prisma.bet.findUnique({
      where: { roundId_userId_panel: { roundId: state.roundId, userId, panel } },
      include: { wallet: { select: { currency: true } }, round: { select: { status: true, crashPoint: true } } },
    });
    if (!bet || bet.status !== "active") return { ok: false, reason: "no_active_bet", userId, panel };

    // Phase 4.5c — AUTHORITATIVE crash gate (money-path-auditor Finding 1). The phase gate
    // above reads engine.getPublicState(), which on a FOLLOWER node is a CACHED, possibly-
    // stale view: in the window between the real crash and the leader's `crashed` pub/sub
    // publish, a follower could otherwise pay a manual cash-out ABOVE the crash. Re-validate
    // against the bet's OWN Round row (the DB is authoritative): the round must still be
    // running AND the multiplier must be STRICTLY below the (server-only, never client-
    // exposed) crashPoint — a cash-out at/above the crash means the bet busted. This makes
    // cash-out node-independent. On the leader / single node it never trips (the in-memory
    // phase flips to `crashed` atomically with the crash), so behavior there is unchanged.
    // MULTI-NODE INVARIANT (concurrent-flip audit): this authoritative re-read is what
    // SUBSTITUTES for a leadership fence on the money path. cashOut/onTick are isLeader()-gated
    // (a fast boolean), NOT fence-gated — so a stale ex-leader's in-flight onTick can still
    // reach cashOut for ~1 heartbeat. This DB re-read (+ the `status='active'` CAS below) is the
    // ONLY thing keeping pay-out exactly-once and never-above-crash across nodes. Do NOT
    // "optimize away" the bet.round re-read or fold the gate into the cached engine state.
    if (bet.round.status !== "running" || mult >= Number(bet.round.crashPoint)) {
      return { ok: false, reason: "too_late", userId, panel };
    }

    // payout = stake × multiplier, clamped to THIS bet's max-win cap: the operator
    // per-currency cap stamped at placeBet (Phase 3), or the global house cap when
    // null. Reading it off the bet keeps the cash-out cap identical to the bet's,
    // and covers server-driven auto-cashout (which has no socket to carry limits).
    // F-001 (money-MOVING, USER-signed-off 2026-06-08): payout = exact integer floor of
    // stake × mult in PURE BigInt — see floorPayout(). The old float
    // `BigInt(Math.floor(Number(bet.amount) * mult))` CREATED money for stakes ≥ 2^53
    // minor units (high-decimal currencies) AND shorted small 2-dp payouts by 1 unit
    // toward the house (e.g. 100 × 1.14 → 113 instead of 114). `mult` is 2-dp (the
    // floored live multiplier or the auto-cashout target).
    const rawPayout = floorPayout(bet.amount, mult);
    const payout = this.risk.capPayout(rawPayout, bet.maxWinPerBet ?? undefined);

    // Atomically CLAIM the bet (active → cashed_out). A manual+auto race (or two
    // sockets) can both read status:"active", but only the update that flips it
    // wins; the loser stops here, so the credit (idempotent anyway) and the
    // leaderboard increment can never be double-counted (audit M1).
    const claim = await this.prisma.bet.updateMany({
      where: { id: bet.id, status: "active" },
      data: { status: "cashed_out", cashoutMult: mult, payout, settledAt: new Date() },
    });
    if (claim.count === 0) return { ok: false, reason: "no_active_bet", userId, panel };

    // Pay the win. A WON payout must NEVER be clawed back: in operator mode the
    // provider retries the idempotent credit and, if it still can't confirm,
    // throws "payout_pending" (H2) instead of rolling back. We then leave the bet
    // recoverable (status payout_pending — settleRound skips non-active bets, so
    // a crash won't bust it) for reconcilePendingPayouts() to re-issue. The
    // internal ledger credit never throws, so this only bites in operator mode.
    let credit: WalletTxResult;
    try {
      credit = await this.wallet$.credit(bet.walletId, payout, "payout_credit", `bet:${bet.id}:payout`, {
        refType: "bet",
        refId: bet.id,
      });
    } catch (e: any) {
      // A claimed win must NEVER be lost. Whatever the provider threw (operator
      // "payout_pending", or any other error), leave the bet RECOVERABLE for the
      // reconciler — never cashed_out-but-unpaid-and-invisible. (The internal
      // ledger credit never throws, so this is operator-mode only.)
      if (e?.message !== "payout_pending") this.metrics.recordError("cashout_credit");
      await this.prisma.bet.update({ where: { id: bet.id }, data: { status: "payout_pending" } });
      return { ok: true, userId, panel, multiplier: mult, payout: Number(payout), currency: bet.wallet.currency, pending: true };
    }
    // confirmed → link the payout tx for reconciliation (was unset).
    await this.prisma.bet.update({ where: { id: bet.id }, data: { payoutTxId: credit.id } });

    // update leaderboard stats (loot += payout, biggest = max)
    await this.prisma.$executeRawUnsafe(
      `UPDATE profiles
         SET total_loot = total_loot + $1::bigint,
             biggest_multiplier = GREATEST(biggest_multiplier, $2),
             updated_at = now()
       WHERE user_id = $3::uuid`,
      payout.toString(), // F-022: bind BigInt as a string + ::bigint cast (Number() truncated >2^53 into the BIGINT column)
      mult,
      userId,
    );

    this.metrics.recordPayout(Number(payout)); // payout → realized-RTP numerator
    // metrics-only: confirmed cash-out → settlement latency (cash-out leg). ONLY the
    // confirmed-credit path; the payout_pending branch above is intentionally excluded
    // (its latency is dominated by the reconciler, not the hot path) (Phase 4.4, §2 Option A).
    this.metrics.observeSettlementLatency(Date.now() - t0);
    return { ok: true, userId, panel, multiplier: mult, payout: Number(payout), balance: Number(credit.balanceAfter), currency: bet.wallet.currency };
  }

  /** Auto-cash any active bets whose target has been reached this tick. */
  async evaluateAutoCashouts(multiplier: number): Promise<CashoutResult[]> {
    const state = this.engine.getPublicState();
    if (!state || state.phase !== "running") return [];
    const due = await this.prisma.bet.findMany({
      where: {
        roundId: state.roundId,
        status: "active",
        autoCashout: { not: null, lte: multiplier },
      },
    });
    const results: CashoutResult[] = [];
    for (const bet of due) {
      try {
        const r = await this.cashOut(bet.userId, bet.panel as Panel, Number(bet.autoCashout));
        if (r.ok) results.push(r);
      } catch {
        // One bet's payout failure (e.g. an operator wallet error) must not abort
        // auto-cashout for the other due bets this tick (audit H2 hardening).
        this.metrics.recordError("auto_cashout");
      }
    }
    return results;
  }

  /** On crash: mark every still-active bet of the round as busted (debit kept). */
  async settleRound(roundId: string): Promise<{ userId: string; panel: Panel }[]> {
    const active = await this.prisma.bet.findMany({ where: { roundId, status: "active" } });
    if (active.length === 0) return [];
    await this.prisma.bet.updateMany({
      where: { roundId, status: "active" },
      data: { status: "busted", settledAt: new Date() },
    });
    return active.map((b) => ({ userId: b.userId, panel: b.panel as Panel }));
  }

  /**
   * Operator-initiated VOID of a SETTLED bet (Phase 6) — fully reverse its money so it
   * is as if it never happened: refund the stake, and for a won bet ALSO reclaim the
   * payout (the clawback). Tenant-scoped by operatorId; idempotent (re-void → no-op);
   * resumable (a partial reversal is finished on retry — the reversals are idempotent).
   *
   * Void rules (operator-signed-off "standard full void"):
   *   busted     → refund stake.
   *   cashed_out → reclaim payout (FIRST) + refund stake.
   *   active                              → reject `bet_not_settled` (settle first).
   *   reserving|cancelling|payout_pending → reject `bet_transient` (retry once settled).
   *   voided                             → idempotent no-op success.
   *   cancelled (player pre-settle cancel)→ already net-zero → no-op success.
   *
   * Atomicity: a CAS claims the bet into `voiding` so two concurrent voids can't both
   * move money. The reclaim runs FIRST — if it fails (e.g. the operator can't reclaim a
   * spent payout) NOTHING was refunded yet and the void aborts cleanly (bet left
   * `voiding`, retryable). The stake refund (returning money) runs second. All moves
   * carry stable idempotency keys and, in operator mode, reverse the ORIGINAL operator
   * transactions (so a void posts as rollbacks, never new turnover → no GGR inflation).
   *
   * NB (cosmetic, not money): the leaderboard total_loot / biggest_multiplier and the
   * realized-RTP metric are NOT reversed here — a void is a rare admin action and those
   * are non-money aggregates. Tracked as a follow-up if exact stat reversal is needed.
   */
  async voidBet(operatorId: string, betId: string, reason?: string): Promise<VoidResult> {
    const bet = await this.prisma.bet.findUnique({
      where: { id: betId },
      select: {
        id: true, operatorId: true, status: true, walletId: true,
        amount: true, payout: true, panel: true, roundId: true, userId: true,
      },
    });
    // Tenant gate: not ours / not found / internal-or-guest (operatorId null) → 404,
    // identical either way (no cross-tenant existence oracle).
    if (!bet || bet.operatorId !== operatorId) throw new NotFoundException("bet_not_found");

    // Idempotent terminal short-circuits (already net-zero).
    if (bet.status === "voided")
      return { ok: true, betId, status: "voided", reversed: false, refundedStake: bet.amount.toString(), reclaimedPayout: bet.payout.toString() };
    if (bet.status === "cancelled")
      return { ok: true, betId, status: "cancelled", reversed: false, refundedStake: bet.amount.toString(), reclaimedPayout: "0" };

    // Reject in-flight / transient states — a void must never race a money move.
    if (bet.status === "active") throw new ConflictException("bet_not_settled");
    if (bet.status === "reserving" || bet.status === "cancelling" || bet.status === "payout_pending")
      throw new ConflictException("bet_transient");

    // Claim a SETTLED bet (busted|cashed_out) into `voiding` via CAS — unless we are
    // RESUMING our own `voiding` (a prior call reversed part and failed to finalise).
    if (bet.status !== "voiding") {
      const claim = await this.prisma.bet.updateMany({
        where: { id: betId, status: bet.status }, // busted | cashed_out
        data: { status: "voiding" },
      });
      if (claim.count === 0) throw new ConflictException("bet_state_changed"); // raced — retry
    }

    // Reverse the money (reclaim-first, idempotent) then finalise voiding → voided.
    const hadPayout = bet.payout > 0n;
    await this.performVoidReversals(bet);
    await this.prisma.bet.updateMany({ where: { id: betId, status: "voiding" }, data: { status: "voided" } });
    this.log.warn(
      `bet ${betId} VOIDED by operator ${operatorId}${reason ? ` (reason: ${reason})` : ""} — ` +
        `refund stake ${bet.amount}${hadPayout ? `, reclaim payout ${bet.payout}` : ""}`,
    );
    return {
      ok: true,
      betId,
      status: "voided",
      reversed: true,
      refundedStake: bet.amount.toString(),
      reclaimedPayout: hadPayout ? bet.payout.toString() : "0",
    };
  }

  /**
   * The two idempotent money reversals of a void, shared by voidBet and the
   * `voiding` finalizer sweep so they ALWAYS use identical keys + ledger types.
   *
   * Reclaim FIRST (the risky clawback) so a failure leaves nothing refunded. Ledger
   * types are chosen so a void NETS CLEANLY in scripts/reconcile-check.ts WITHOUT a
   * script change, exactly like a player cancel: the stake refund is a `refund` (nets
   * invariant 1a) and the payout reclaim is a NEGATIVE `payout_credit` (nets 1b), BOTH
   * `refType:"bet"`/`refId:betId` so the reconcile join sees them. In operator mode each
   * `reverse` rolls back the ORIGINAL operator transaction (no GGR inflation). All
   * idempotent on their reverse keys (and on the original key at the operator).
   */
  private async performVoidReversals(bet: {
    id: string; walletId: string; amount: bigint; payout: bigint; roundId: string; userId: string; panel: string;
  }): Promise<void> {
    if (bet.payout > 0n) {
      await this.wallet$.reverse(bet.walletId, {
        originalKey: `bet:${bet.id}:payout`,
        reverseKey: `bet:${bet.id}:void_reclaim`,
        amount: bet.payout,
        originalDirection: "credit",
        type: "payout_credit", // negative payout_credit → nets the original payout in reconcile 1b
        ref: { refType: "bet", refId: bet.id },
      });
    }
    await this.wallet$.reverse(bet.walletId, {
      originalKey: `bet:${bet.roundId}:${bet.userId}:${bet.panel}:debit`,
      reverseKey: `bet:${bet.id}:void_refund`,
      amount: bet.amount,
      originalDirection: "debit",
      type: "refund", // mirrors a cancel refund → nets the original debit in reconcile 1a
      ref: { refType: "bet", refId: bet.id },
    });
  }

  /**
   * Finalize bets stranded in `voiding` (an operator void interrupted between the
   * reclaim and refund legs, or before the status flip) — re-run the idempotent
   * reversals and finalise. The owed money is thus self-healed without relying on the
   * operator to re-POST the void (the H2-style recovery the other half-done money
   * states already have). Both wallet modes (a demo void reverses on the ledger).
   * Overlap-guarded by the caller; leader-gated by the gateway. Loudly alerts on any
   * that remain stuck (owed refunds), never abandoning them. Returns how many finalised.
   */
  async reconcileVoidingBets(limit = 50): Promise<number> {
    const stuck = await this.prisma.bet.findMany({
      where: { status: "voiding" },
      take: limit,
      select: { id: true, walletId: true, amount: true, payout: true, roundId: true, userId: true, panel: true },
    });
    let finalized = 0;
    for (const bet of stuck) {
      try {
        await this.performVoidReversals(bet);
        const done = await this.prisma.bet.updateMany({ where: { id: bet.id, status: "voiding" }, data: { status: "voided" } });
        if (done.count > 0) finalized++;
      } catch {
        // Still failing (e.g. operator down / a clawback the operator rejects) — leave
        // `voiding`, retry next sweep. Per-bet errors recorded; never abandoned.
        this.metrics.recordError("void_reconcile");
      }
    }
    // Alert on anything still stuck AFTER the retry loop (owed refunds not yet finalised).
    const remaining = await this.prisma.bet.count({ where: { status: "voiding" } });
    if (remaining > 0)
      this.log.error(
        `${remaining} bet(s) stuck in 'voiding' — an operator void is incomplete (owed refund not finalised); the sweep keeps retrying.`,
      );
    return finalized;
  }

  /**
   * Re-issue idempotent payouts for bets stuck in `payout_pending` (operator-mode
   * H2 recovery). Safe to call repeatedly: the operator dedups on the payout key,
   * so a win that already applied during a timeout simply confirms, and one that
   * didn't gets paid now. On confirmation the bet is finalised (cashed_out +
   * payoutTxId + leaderboard, counted toward realized RTP). Returns how many were
   * recovered. No-op when nothing is pending (the internal ledger never pends).
   */
  async reconcilePendingPayouts(limit = 50): Promise<number> {
    const pending = await this.prisma.bet.findMany({ where: { status: "payout_pending" }, take: limit });
    let recovered = 0;
    for (const bet of pending) {
      try {
        const credit = await this.wallet$.credit(bet.walletId, bet.payout, "payout_credit", `bet:${bet.id}:payout`, {
          refType: "bet",
          refId: bet.id,
        });
        // Finalise atomically; if a concurrent cycle already did, skip (so the
        // leaderboard is never double-counted).
        const done = await this.prisma.bet.updateMany({
          where: { id: bet.id, status: "payout_pending" },
          data: { status: "cashed_out", payoutTxId: credit.id },
        });
        if (done.count === 0) continue;
        await this.prisma.$executeRawUnsafe(
          `UPDATE profiles
             SET total_loot = total_loot + $1::bigint,
                 biggest_multiplier = GREATEST(biggest_multiplier, $2),
                 updated_at = now()
           WHERE user_id = $3::uuid`,
          bet.payout.toString(), // F-022: BigInt as string + ::bigint cast (was lossy Number())
          Number(bet.cashoutMult ?? 1),
          bet.userId,
        );
        this.metrics.recordPayout(Number(bet.payout)); // confirmed now → RTP numerator
        recovered++;
      } catch {
        // Still unconfirmed (operator down) — leave payout_pending; retry next cycle.
        this.metrics.recordError("payout_reconcile");
      }
    }
    // Reflect the live backlog AFTER the retry loop (cleared payouts drop out,
    // so the gauge falls to 0 when nothing is owed) and escalate stuck ones.
    await this.reportPendingBacklog();
    return recovered;
  }

  /** Count bets stuck in payout_pending (operator-mode owed payouts). Cheap. */
  async countPendingPayouts(): Promise<number> {
    return this.prisma.bet.count({ where: { status: "payout_pending" } });
  }

  /**
   * Refresh the pending-payout gauges from the live table and loudly log any
   * payout that has been stuck past PAYOUT_PENDING_ALERT_SEC — WITHOUT ever
   * abandoning it (status is untouched; the reconciler keeps retrying forever).
   * Cheap: one count + one findFirst(orderBy settledAt asc). "Pending since" is
   * settledAt (set when cashOut claimed the bet).
   */
  private async reportPendingBacklog(): Promise<void> {
    const count = await this.countPendingPayouts();
    if (count === 0) {
      this.metrics.setPendingPayouts(0, 0);
      return;
    }
    const oldest = await this.prisma.bet.findFirst({
      where: { status: "payout_pending" },
      orderBy: { settledAt: "asc" },
      select: { id: true, settledAt: true, payout: true },
    });
    const oldestMs = oldest?.settledAt ? Date.now() - oldest.settledAt.getTime() : 0;
    const oldestAgeSeconds = Math.max(0, Math.floor(oldestMs / 1000));
    this.metrics.setPendingPayouts(count, oldestAgeSeconds);

    if (oldestAgeSeconds > PAYOUT_PENDING_ALERT_SEC) {
      // Loud + actionable: which bet, how old, how many behind it. Never given up on.
      this.log.error(
        `STUCK operator payout: bet ${oldest?.id} owed ${oldest?.payout} pending ${oldestAgeSeconds}s ` +
          `(> ${PAYOUT_PENDING_ALERT_SEC}s); ${count} payout(s) pending total. ` +
          `Still retrying — a won payout is never abandoned. Check the operator wallet.`,
      );
    }
  }

  /**
   * Refresh the transient-reservation gauges (reserving|cancelling) from the live
   * table and loudly log any slot stuck past RESERVING_ALERT_SEC — an owed refund the
   * sweep hasn't cleared (e.g. a cancelling slot whose reversal keeps failing). The
   * sweep keeps retrying forever; this only escalates visibility (status untouched).
   * Cheap: one count + one findFirst(orderBy createdAt asc). Called at the end of each
   * sweep cycle (audit Low-4).
   */
  async reportReservingBacklog(): Promise<void> {
    const count = await this.prisma.bet.count({ where: { status: { in: ["reserving", "cancelling"] } } });
    if (count === 0) {
      this.metrics.setReservingBacklog(0, 0);
      return;
    }
    const oldest = await this.prisma.bet.findFirst({
      where: { status: { in: ["reserving", "cancelling"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, createdAt: true },
    });
    const oldestMs = oldest?.createdAt ? Date.now() - oldest.createdAt.getTime() : 0;
    const oldestAgeSeconds = Math.max(0, Math.floor(oldestMs / 1000));
    this.metrics.setReservingBacklog(count, oldestAgeSeconds);

    if (oldestAgeSeconds > RESERVING_ALERT_SEC) {
      this.log.error(
        `STUCK reservation: bet ${oldest?.id} (${oldest?.status}) stranded ${oldestAgeSeconds}s ` +
          `(> ${RESERVING_ALERT_SEC}s); ${count} reserving/cancelling slot(s) total. ` +
          `The sweep keeps retrying — an owed refund is never abandoned. Check the wallet/DB.`,
      );
    }
  }
}
