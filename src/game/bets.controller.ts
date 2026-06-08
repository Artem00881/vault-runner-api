import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUserId, JwtAuthGuard } from "../auth/jwt-auth.guard";

function serialize(b: {
  id: string;
  roundId: string;
  panel: string;
  amount: bigint;
  autoCashout: unknown;
  status: string;
  cashoutMult: unknown;
  payout: bigint;
  createdAt: Date;
}) {
  return {
    id: b.id,
    roundId: b.roundId,
    panel: b.panel,
    amount: Number(b.amount),
    autoCashout: b.autoCashout != null ? Number(b.autoCashout) : null,
    status: b.status,
    cashoutMult: b.cashoutMult != null ? Number(b.cashoutMult) : null,
    payout: Number(b.payout),
    createdAt: b.createdAt,
  };
}

@Controller("api/bets")
@UseGuards(JwtAuthGuard)
export class BetsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Active bets (for resync after a reconnect). Includes `payout_pending` (F-071): a bet
   *  that WON but whose operator payout hasn't confirmed is still owed money the reconnecting
   *  player must see ("win pending confirmation") — its `payout` is serialized so the UI can
   *  show the owed amount. Money is safe either way (the reconciler keeps retrying); this is a
   *  player-facing display fix. Read-only. */
  @Get("active")
  async active(@CurrentUserId() userId: string) {
    const rows = await this.prisma.bet.findMany({
      where: { userId, status: { in: ["active", "payout_pending"] } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(serialize);
  }

  /** Recent bet history. */
  @Get("history")
  async history(@CurrentUserId() userId: string) {
    const rows = await this.prisma.bet.findMany({
      // exclude the transient recovery states ('reserving' pre-debit, 'cancelling'
      // mid-reversal) — not placed bets the player should see in history.
      where: { userId, status: { notIn: ["reserving", "cancelling"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map(serialize);
  }
}
