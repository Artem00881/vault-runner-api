import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LedgerService } from "./ledger.service";
import { WalletController } from "./wallet.controller";

@Module({
  imports: [AuthModule],
  controllers: [WalletController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class WalletModule {}
