import { Module } from "@nestjs/common";
import { FairnessService } from "./fairness.service";
import { FairnessController } from "./fairness.controller";
import { DailySaltProvider, EthBlockSaltProvider, SALT_PROVIDER, type SaltProvider } from "./salt.provider";

@Module({
  controllers: [FairnessController],
  providers: [
    FairnessService,
    {
      // SALT_PROVIDER_TYPE=eth-block → grind-proof future-block-hash salt (real money);
      // default "random" → operator-published random salt (demo / play-money).
      provide: SALT_PROVIDER,
      useFactory: (): SaltProvider =>
        process.env.SALT_PROVIDER_TYPE === "eth-block" ? new EthBlockSaltProvider() : new DailySaltProvider(),
    },
  ],
  exports: [FairnessService],
})
export class FairnessModule {}
