import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OperatorModule } from "../operator/operator.module";
import { GameSessionService } from "../operator/game-session.service";
import { PrismaService } from "../prisma/prisma.service";
import { LedgerModule } from "./ledger.module";
import { LedgerService } from "./ledger.service";
import { WalletController } from "./wallet.controller";
import { WALLET_PROVIDER, OPERATOR_WALLET_API } from "./wallet-provider";
import { WalletRouter } from "./wallet-router";
import { SeamlessOperatorWallet } from "./seamless-operator-wallet";
import { WalletRollbackService } from "./wallet-rollback.service";
import type { OperatorWalletApi } from "./operator-wallet.types";
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
    WalletRollbackService,
    {
      // The raw per-operator wallet client (or null in internal mode). Built ONCE here and
      // shared with WALLET_PROVIDER below; the M1 rollback-outbox drain re-emits through it.
      provide: OPERATOR_WALLET_API,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService): OperatorWalletApi | null => {
        const type = process.env.WALLET_PROVIDER_TYPE ?? "internal";
        if (type !== "operator") return null; // internal mode → no operator to call
        // operatorId → its seamless-wallet endpoint (URL + key), cached.
        const resolveEndpoint = cachedEndpointResolver(async (operatorId): Promise<OperatorEndpoint> => {
          const op = await prisma.operator.findUniqueOrThrow({ where: { id: operatorId } });
          return { walletApiUrl: op.walletApiUrl ?? "", walletApiKey: op.walletApiKey ?? null };
        });
        return new HttpOperatorWalletApi(resolveEndpoint);
      },
    },
    {
      provide: WALLET_PROVIDER,
      inject: [LedgerService, GameSessionService, OPERATOR_WALLET_API, WalletRollbackService],
      useFactory: (
        ledger: LedgerService,
        sessions: GameSessionService,
        operatorApi: OperatorWalletApi | null,
        rollbacks: WalletRollbackService,
      ) => {
        const type = process.env.WALLET_PROVIDER_TYPE ?? "internal";
        if (type === "internal") return ledger;
        if (type === "operator") {
          // operatorApi is the shared client built by OPERATOR_WALLET_API (non-null here).
          // M1: pass the durable rollback ledger (F-002 once-only + F-027 outbox). Default
          // SeamlessOptions (3 retries) is unchanged — the {} keeps the positional 4th arg.
          const operatorWallet = new SeamlessOperatorWallet(operatorApi!, sessions.resolver(), {}, rollbacks);
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
  exports: [LedgerModule, WALLET_PROVIDER, OPERATOR_WALLET_API, WalletRollbackService],
})
export class WalletModule {}
