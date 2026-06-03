import { Controller, Get, UseGuards, Inject, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUserId, CurrentWalletId, JwtAuthGuard } from "../auth/jwt-auth.guard";
import { WALLET_PROVIDER, type WalletProvider } from "./wallet-provider";

@Controller("api/wallet")
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly wallet$: WalletProvider,
  ) {}

  // Resolve the wallet for display. Prefer the EXACT walletId the operator session
  // bound (audit M-C2.1 / L-1) — robust if a user ever holds more than one wallet
  // (multi-currency); verify it belongs to the authenticated user (sub stays the
  // trust anchor). Guests carry no walletId → their single wallet by userId.
  private async resolveWallet(userId: string, walletId?: string) {
    if (walletId) {
      const w = await this.prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
      if (w.userId !== userId) throw new ForbiddenException("wallet_mismatch");
      return w;
    }
    return this.prisma.wallet.findFirstOrThrow({ where: { userId } });
  }

  @Get("balance")
  async balance(@CurrentUserId() userId: string, @CurrentWalletId() walletId?: string) {
    const w = await this.resolveWallet(userId, walletId);
    // Operator-aware: in operator mode this returns the OPERATOR's real balance
    // (the local journal wallet is not authoritative); internal mode = local.
    const balance = await this.wallet$.getBalance(w.id);
    return { currency: w.currency, balance: Number(balance) };
  }

  // The LOCAL ledger journal. In operator mode the operator's wallet is the
  // source of truth, so this is our reconciliation journal — not the player's
  // authoritative statement (which lives at the operator). Local by design.
  @Get("transactions")
  async transactions(@CurrentUserId() userId: string, @CurrentWalletId() walletId?: string) {
    const w = await this.resolveWallet(userId, walletId);
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
