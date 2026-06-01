import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LedgerService } from "./ledger.service";
import { WalletController } from "./wallet.controller";
import { WALLET_PROVIDER } from "./wallet-provider";

/**
 * Selects the active WalletProvider.
 *
 *  - "internal" (default): the built-in append-only ledger (LedgerService) —
 *    our DB is the source of truth. Powers the demo / play-money build.
 *  - "operator": SeamlessOperatorWallet — the operator's wallet is the source of
 *    truth. NOT wired here yet: it needs a real OperatorWalletApi client + a
 *    launch-token session resolver (Phase 0.3). Until then, selecting "operator"
 *    intentionally throws so we never silently run real-money mode unconfigured.
 *
 * Controlled by env `WALLET_PROVIDER_TYPE` (default "internal").
 */
@Module({
  imports: [AuthModule],
  controllers: [WalletController],
  providers: [
    LedgerService,
    {
      provide: WALLET_PROVIDER,
      inject: [LedgerService],
      useFactory: (ledger: LedgerService) => {
        const type = process.env.WALLET_PROVIDER_TYPE ?? "internal";
        if (type === "internal") return ledger;
        if (type === "operator") {
          throw new Error(
            "WALLET_PROVIDER_TYPE=operator requires an operator wallet client + " +
              "launch-token session resolver (Phase 0.3) — not wired yet.",
          );
        }
        throw new Error(`unknown WALLET_PROVIDER_TYPE: ${type}`);
      },
    },
  ],
  exports: [LedgerService, WALLET_PROVIDER],
})
export class WalletModule {}
