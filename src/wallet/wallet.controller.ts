import { Controller, Get, UseGuards, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUserId, JwtAuthGuard } from "../auth/jwt-auth.guard";
import { WALLET_PROVIDER, type WalletProvider } from "./wallet-provider";

@Controller("api/wallet")
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly wallet$: WalletProvider,
  ) {}

  // A user has exactly one wallet (guests: DEMO; operator players: the launch
  // currency). Resolve by userId, not a hardcoded currency (audit C2).
  @Get("balance")
  async balance(@CurrentUserId() userId: string) {
    const w = await this.prisma.wallet.findFirstOrThrow({ where: { userId } });
    // Operator-aware: in operator mode this returns the OPERATOR's real balance
    // (the local journal wallet is not authoritative); internal mode = local.
    const balance = await this.wallet$.getBalance(w.id);
    return { currency: w.currency, balance: Number(balance) };
  }

  // The LOCAL ledger journal. In operator mode the operator's wallet is the
  // source of truth, so this is our reconciliation journal — not the player's
  // authoritative statement (which lives at the operator). Local by design.
  @Get("transactions")
  async transactions(@CurrentUserId() userId: string) {
    const w = await this.prisma.wallet.findFirstOrThrow({ where: { userId } });
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
