import { Module } from "@nestjs/common";
import { FairnessService } from "./fairness.service";
import { FairnessController } from "./fairness.controller";
import { DailySaltProvider, SALT_PROVIDER } from "./salt.provider";

@Module({
  controllers: [FairnessController],
  providers: [
    FairnessService,
    { provide: SALT_PROVIDER, useClass: DailySaltProvider },
  ],
  exports: [FairnessService],
})
export class FairnessModule {}
