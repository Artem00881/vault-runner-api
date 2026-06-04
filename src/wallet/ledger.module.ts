import { Module } from "@nestjs/common";
import { LedgerService } from "./ledger.service";

/**
 * Standalone module for the internal play-money ledger.
 *
 * Extracted so BOTH WalletModule (which selects the active WalletProvider) and
 * OperatorModule (whose GameSessionService seeds/resets demo "fun mode" wallets)
 * can inject LedgerService WITHOUT a circular module dependency — WalletModule
 * imports OperatorModule, so OperatorModule must not import WalletModule. The
 * ledger depends only on the (global) PrismaService, so this module is a leaf.
 */
@Module({
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
