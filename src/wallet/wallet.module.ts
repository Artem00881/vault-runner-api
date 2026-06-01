import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OperatorModule } from "../operator/operator.module";
import { GameSessionService } from "../operator/game-session.service";
import { PrismaService } from "../prisma/prisma.service";
import { LedgerService } from "./ledger.service";
import { WalletController } from "./wallet.controller";
import { WALLET_PROVIDER } from "./wallet-provider";
import { SeamlessOperatorWallet } from "./seamless-operator-wallet";
import {
  HttpOperatorWalletApi,
  cachedEndpointResolver,
  type OperatorEndpoint,
} from "./http-operator-wallet";

/**
 * Selects the active WalletProvider.
 *
 *  - "internal" (default): the built-in append-only ledger (LedgerService) —
 *    our DB is the source of truth. Powers the demo / play-money build.
 *  - "operator": SeamlessOperatorWallet over a real HTTP operator wallet — the
 *    operator's wallet is the source of truth. Wired here (Phase 0 end-to-end):
 *    the HTTP client routes each call to the operator's own walletApiUrl/Key
 *    (looked up by operatorId, cached), and the launch-token session resolver
 *    (GameSessionService) maps a local walletId → operator player/currency.
 *
 * Controlled by env `WALLET_PROVIDER_TYPE` (default "internal").
 */
@Module({
  imports: [AuthModule, OperatorModule],
  controllers: [WalletController],
  providers: [
    LedgerService,
    {
      provide: WALLET_PROVIDER,
      inject: [LedgerService, GameSessionService, PrismaService],
      useFactory: (
        ledger: LedgerService,
        sessions: GameSessionService,
        prisma: PrismaService,
      ) => {
        const type = process.env.WALLET_PROVIDER_TYPE ?? "internal";
        if (type === "internal") return ledger;
        if (type === "operator") {
          // operatorId → its seamless-wallet endpoint (URL + key), cached.
          const resolveEndpoint = cachedEndpointResolver(async (operatorId): Promise<OperatorEndpoint> => {
            const op = await prisma.operator.findUniqueOrThrow({ where: { id: operatorId } });
            return { walletApiUrl: op.walletApiUrl ?? "", walletApiKey: op.walletApiKey ?? null };
          });
          const client = new HttpOperatorWalletApi(resolveEndpoint);
          return new SeamlessOperatorWallet(client, sessions.resolver());
        }
        throw new Error(`unknown WALLET_PROVIDER_TYPE: ${type}`);
      },
    },
  ],
  exports: [LedgerService, WALLET_PROVIDER],
})
export class WalletModule {}
