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

  /** Active bets (for resync after a reconnect). */
  @Get("active")
  async active(@CurrentUserId() userId: string) {
    const rows = await this.prisma.bet.findMany({
      where: { userId, status: "active" },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(serialize);
  }

  /** Recent bet history. */
  @Get("history")
  async history(@CurrentUserId() userId: string) {
    const rows = await this.prisma.bet.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map(serialize);
  }
}
