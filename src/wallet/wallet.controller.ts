import { Controller, Get, UseGuards } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUserId, JwtAuthGuard } from "../auth/jwt-auth.guard";
import { DEMO_CURRENCY } from "../auth/auth.service";

@Controller("api/wallet")
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("balance")
  async balance(@CurrentUserId() userId: string) {
    const w = await this.prisma.wallet.findFirstOrThrow({
      where: { userId, currency: DEMO_CURRENCY },
    });
    return { currency: w.currency, balance: Number(w.balance) };
  }

  @Get("transactions")
  async transactions(@CurrentUserId() userId: string) {
    const w = await this.prisma.wallet.findFirstOrThrow({
      where: { userId, currency: DEMO_CURRENCY },
    });
    const rows = await this.prisma.ledgerTransaction.findMany({
      where: { walletId: w.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      amount: Number(r.amount),
      balanceAfter: Number(r.balanceAfter),
      refType: r.refType,
      refId: r.refId,
      createdAt: r.createdAt,
    }));
  }
}
