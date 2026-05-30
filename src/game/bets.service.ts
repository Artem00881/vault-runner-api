import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { LedgerService } from "../wallet/ledger.service";
import { DEMO_CURRENCY } from "../auth/auth.service";
import { GameEngineService } from "./game-engine.service";

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

const MIN_BET = 1n;
const MAX_BET = 1_000_000n;

/**
 * All money-moving bet operations, validated against the authoritative engine
 * (server clock decides phase) and applied through the idempotent ledger.
 */
@Injectable()
export class BetsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(GameEngineService) private readonly engine: GameEngineService,
  ) {}

  private async wallet(userId: string) {
    return this.prisma.wallet.findFirstOrThrow({ where: { userId, currency: DEMO_CURRENCY } });
  }

  /** Place a bet on the CURRENT round during the betting window. */
  async placeBet(userId: string, panel: Panel, amount: number, autoCashout?: number): Promise<BetResult> {
    const state = this.engine.getPublicState();
    if (!state || state.phase !== "betting") return { ok: false, reason: "betting_closed", panel };

    const amt = BigInt(Math.floor(amount));
    if (amt < MIN_BET || amt > MAX_BET) return { ok: false, reason: "invalid_amount", panel };

    const roundId = state.roundId;
    const existing = await this.prisma.bet.findUnique({
      where: { roundId_userId_panel: { roundId, userId, panel } },
    });
    if (existing) return { ok: false, reason: "already_bet", panel };

    const wallet = await this.wallet(userId);
    const betId = randomUUID();
    try {
      const tx = await this.ledger.debit(wallet.id, amt, "bet_debit", `bet:${betId}:debit`, {
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
      return { ok: true, panel, balance: Number(tx.balanceAfter), betId };
    } catch (e: any) {
      return { ok: false, reason: e?.message === "insufficient_balance" ? "insufficient_balance" : "bet_failed", panel };
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

    const refund = await this.ledger.credit(bet.walletId, bet.amount, "refund", `bet:${bet.id}:refund`, {
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

    const payout = BigInt(Math.floor(Number(bet.amount) * mult));
    const credit = await this.ledger.credit(bet.walletId, payout, "payout_credit", `bet:${bet.id}:payout`, {
      refType: "bet",
      refId: bet.id,
    });
    await this.prisma.bet.update({
      where: { id: bet.id },
      data: { status: "cashed_out", cashoutMult: mult, payout, settledAt: new Date() },
    });

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
      const r = await this.cashOut(bet.userId, bet.panel as Panel, Number(bet.autoCashout));
      if (r.ok) results.push(r);
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
