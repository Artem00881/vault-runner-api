import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { WALLET_PROVIDER, type WalletProvider, type WalletTxResult } from "../wallet/wallet-provider";
import { GameEngineService } from "./game-engine.service";
import { RiskService } from "./risk.service";
import { MetricsService } from "../metrics/metrics.service";

export type Panel = "A" | "B";

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

/**
 * All money-moving bet operations, validated against the authoritative engine
 * (server clock decides phase) and applied through the idempotent ledger.
 */
// A payout_pending bet older than this (seconds) is "stuck" — log it loudly so
// it's visible/alertable. We NEVER abandon a won payout; this only escalates
// noise, the reconciler keeps retrying forever. Env-tunable (H2 operability).
const PAYOUT_PENDING_ALERT_SEC = Number(process.env.PAYOUT_PENDING_ALERT_SEC ?? 3600);

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
      if (w.userId !== userId) throw new Error(`wallet ${walletId} does not belong to user ${userId}`);
      return w;
    }
    return this.prisma.wallet.findFirstOrThrow({ where: { userId } });
  }

  /** Place a bet on the CURRENT round during the betting window. */
  async placeBet(userId: string, panel: Panel, amount: number, autoCashout?: number, walletId?: string): Promise<BetResult> {
    const state = this.engine.getPublicState();
    if (!state || state.phase !== "betting") return { ok: false, reason: "betting_closed", panel };

    const amt = BigInt(Math.floor(amount));
    const amtCheck = this.risk.checkBetAmount(amt);
    if (!amtCheck.ok) { this.metrics.recordRejected(amtCheck.reason); return { ok: false, reason: amtCheck.reason, panel }; }

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
      return null;
    });
    if (!wallet) {
      this.metrics.recordRejected("bet_failed");
      return { ok: false, reason: "bet_failed", panel };
    }
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
          select: { amount: true },
        });
        const currentExposure = roundBets.reduce((sum, b) => sum + this.risk.potentialPayout(b.amount), 0n);
        const expCheck = this.risk.checkRoundExposure(currentExposure, amt);
        if (!expCheck.ok) { rejectReason = expCheck.reason; throw new Error("reserve_rejected"); }
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
    const state = this.engine.getPublicState();
    if (!state || state.phase !== "running") return { ok: false, reason: "too_late", userId, panel };

    const mult = atMultiplier ?? this.engine.currentMultiplier();
    const bet = await this.prisma.bet.findUnique({
      where: { roundId_userId_panel: { roundId: state.roundId, userId, panel } },
      include: { wallet: { select: { currency: true } } },
    });
    if (!bet || bet.status !== "active") return { ok: false, reason: "no_active_bet", userId, panel };

    // payout = stake × multiplier, clamped to the per-bet max-win cap (house safeguard)
    const rawPayout = BigInt(Math.floor(Number(bet.amount) * mult));
    const payout = this.risk.capPayout(rawPayout);

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
         SET total_loot = total_loot + $1,
             biggest_multiplier = GREATEST(biggest_multiplier, $2),
             updated_at = now()
       WHERE user_id = $3::uuid`,
      Number(payout),
      mult,
      userId,
    );

    this.metrics.recordPayout(Number(payout)); // payout → realized-RTP numerator
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
             SET total_loot = total_loot + $1,
                 biggest_multiplier = GREATEST(biggest_multiplier, $2),
                 updated_at = now()
           WHERE user_id = $3::uuid`,
          Number(bet.payout),
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
}
