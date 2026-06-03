import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { WALLET_PROVIDER, type WalletProvider } from "../wallet/wallet-provider";
import { DEMO_CURRENCY } from "../auth/auth.service";
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
}
export interface CashoutResult {
  ok: boolean;
  reason?: string;
  userId?: string;
  panel: Panel;
  multiplier?: number;
  payout?: number;
  balance?: number;
}

/**
 * All money-moving bet operations, validated against the authoritative engine
 * (server clock decides phase) and applied through the idempotent ledger.
 */
@Injectable()
export class BetsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    // talks to the active WalletProvider (internal ledger today; operator wallet
    // later) — not LedgerService directly, so the money source can be swapped.
    @Inject(WALLET_PROVIDER) private readonly wallet$: WalletProvider,
    @Inject(GameEngineService) private readonly engine: GameEngineService,
    @Inject(RiskService) private readonly risk: RiskService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  private async wallet(userId: string) {
    return this.prisma.wallet.findFirstOrThrow({ where: { userId, currency: DEMO_CURRENCY } });
  }

  /** Place a bet on the CURRENT round during the betting window. */
  async placeBet(userId: string, panel: Panel, amount: number, autoCashout?: number): Promise<BetResult> {
    const state = this.engine.getPublicState();
    if (!state || state.phase !== "betting") return { ok: false, reason: "betting_closed", panel };

    const amt = BigInt(Math.floor(amount));
    const amtCheck = this.risk.checkBetAmount(amt);
    if (!amtCheck.ok) { this.metrics.recordRejected(amtCheck.reason); return { ok: false, reason: amtCheck.reason, panel }; }

    const roundId = state.roundId;
    const existing = await this.prisma.bet.findUnique({
      where: { roundId_userId_panel: { roundId, userId, panel } },
    });
    if (existing) return { ok: false, reason: "already_bet", panel };

    // House risk: reject if this bet would push the round's worst-case payout
    // past the bankroll exposure cap (computed from all active bets this round).
    const roundBets = await this.prisma.bet.findMany({
      where: { roundId, status: "active" },
      select: { amount: true },
    });
    const currentExposure = roundBets.reduce((sum, b) => sum + this.risk.potentialPayout(b.amount), 0n);
    const expCheck = this.risk.checkRoundExposure(currentExposure, amt);
    if (!expCheck.ok) { this.metrics.recordRejected(expCheck.reason); return { ok: false, reason: expCheck.reason, panel }; }

    const wallet = await this.wallet(userId);
    const betId = randomUUID();
    // Idempotency key is bound to the LOGICAL bet (round+user+panel), not the
    // per-attempt id, so a concurrent/retried duplicate dedups in the ledger
    // instead of charging twice for one bet (audit C1).
    const debitKey = `bet:${roundId}:${userId}:${panel}:debit`;
    try {
      const tx = await this.wallet$.debit(wallet.id, amt, "bet_debit", debitKey, {
        refType: "bet",
        refId: betId,
      });
      await this.prisma.bet.create({
        data: {
          id: betId,
          roundId,
          userId,
          walletId: wallet.id,
          panel,
          amount: amt,
          autoCashout: autoCashout ?? null,
          status: "active",
          debitTxId: tx.id,
        },
      });
      this.metrics.recordBet(Number(amt)); // stake → realized-RTP denominator
      return { ok: true, panel, balance: Number(tx.balanceAfter), betId };
    } catch (e: any) {
      // Lost a concurrent race for the same (round,user,panel): the bet row
      // already exists (P2002) and the debit above was deduped — no double charge.
      if (e?.code === "P2002") return { ok: false, reason: "already_bet", panel };
      const reason = e?.message === "insufficient_balance" ? "insufficient_balance" : "bet_failed";
      this.metrics.recordRejected(reason);
      return { ok: false, reason, panel };
    }
  }

  /** Cancel an active bet before the round starts (refund). */
  async cancelBet(userId: string, panel: Panel): Promise<BetResult> {
    const state = this.engine.getPublicState();
    if (!state || state.phase !== "betting") return { ok: false, reason: "betting_closed", panel };
    const bet = await this.prisma.bet.findUnique({
      where: { roundId_userId_panel: { roundId: state.roundId, userId, panel } },
    });
    if (!bet || bet.status !== "active") return { ok: false, reason: "no_active_bet", panel };

    const refund = await this.wallet$.credit(bet.walletId, bet.amount, "refund", `bet:${bet.id}:refund`, {
      refType: "bet",
      refId: bet.id,
    });
    await this.prisma.bet.update({ where: { id: bet.id }, data: { status: "cancelled", settledAt: new Date() } });
    return { ok: true, panel, balance: Number(refund.balanceAfter) };
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

    // NOTE (audit H2, operator track): in operator mode `credit` can throw on an
    // ambiguous timeout, leaving the bet claimed-but-unpaid. A compensation/retry
    // path must be designed (with the money-path-auditor) before enabling
    // WALLET_PROVIDER_TYPE=operator. The internal ledger credit does not throw.
    const credit = await this.wallet$.credit(bet.walletId, payout, "payout_credit", `bet:${bet.id}:payout`, {
      refType: "bet",
      refId: bet.id,
    });
    // link the cashed-out bet to its payout tx for reconciliation (was unset).
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
    return { ok: true, userId, panel, multiplier: mult, payout: Number(payout), balance: Number(credit.balanceAfter) };
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
}
