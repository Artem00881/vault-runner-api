import { Global, Module } from "@nestjs/common";
import { MetricsService } from "./metrics.service";
import { MetricsController } from "./metrics.controller";
import { VersionController } from "./version.controller";

/**
 * Global so any service (bets, gateway, engine) can record metrics by injecting
 * MetricsService without importing the module everywhere.
 */
@Global()
@Module({
  controllers: [MetricsController, VersionController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
