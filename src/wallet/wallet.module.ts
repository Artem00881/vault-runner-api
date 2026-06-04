import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OperatorModule } from "../operator/operator.module";
import { GameSessionService } from "../operator/game-session.service";
import { PrismaService } from "../prisma/prisma.service";
import { LedgerModule } from "./ledger.module";
import { LedgerService } from "./ledger.service";
import { WalletController } from "./wallet.controller";
import { WALLET_PROVIDER } from "./wallet-provider";
import { WalletRouter } from "./wallet-router";
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
  imports: [AuthModule, OperatorModule, LedgerModule],
  controllers: [WalletController],
  providers: [
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
          const operatorWallet = new SeamlessOperatorWallet(client, sessions.resolver());
          // Route per wallet: a DEMO ("fun mode") session plays with play money on the
          // internal ledger and NEVER hits the operator wallet; real sessions go to the
          // operator. The router keys purely on walletId (demo wallets are distinct
          // journals) and fails SAFE to the ledger — see WalletRouter (Phase 3).
          return new WalletRouter(ledger, operatorWallet, (walletId) => sessions.isDemoWallet(walletId));
        }
        throw new Error(`unknown WALLET_PROVIDER_TYPE: ${type}`);
      },
    },
  ],
  exports: [LedgerModule, WALLET_PROVIDER],
})
export class WalletModule {}
