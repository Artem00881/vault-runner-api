import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LedgerService } from "./ledger.service";
import { WalletController } from "./wallet.controller";
import { WALLET_PROVIDER } from "./wallet-provider";

@Module({
  imports: [AuthModule],
  controllers: [WalletController],
  providers: [
    LedgerService,
    // The active WalletProvider. Today it's the internal ledger; a
    // SeamlessOperatorWallet (Phase 0.2) is registered here behind an env flag.
    { provide: WALLET_PROVIDER, useExisting: LedgerService },
  ],
  // Export both: LedgerService for the wallet controller's direct reads, and
  // the WALLET_PROVIDER token for game logic (BetsService) to depend on.
  exports: [LedgerService, WALLET_PROVIDER],
})
export class WalletModule {}
