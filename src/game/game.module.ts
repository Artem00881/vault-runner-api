import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { RedisModule } from "../redis/redis.module";
import { FairnessModule } from "../fairness/fairness.module";
import { WalletModule } from "../wallet/wallet.module";
import { AuthModule } from "../auth/auth.module";
import { OperatorModule } from "../operator/operator.module";
import { GameEngineService } from "./game-engine.service";
import { GameGateway } from "./game.gateway";
import { BetsService } from "./bets.service";
import { RiskService, assertRiskConfigForMode } from "./risk.service";
import { RoundsController } from "./rounds.controller";
import { BetsController } from "./bets.controller";

@Module({
  imports: [PrismaModule, RedisModule, FairnessModule, WalletModule, AuthModule, OperatorModule],
  controllers: [RoundsController, BetsController],
  providers: [
    GameEngineService,
    GameGateway,
    BetsService,
    // Fail CLOSED at boot in operator/real-money mode if the RISK_* ceilings are still
    // demo-grade defaults (go-live guard, mirrors fairness.module's salt guard).
    { provide: RiskService, useFactory: () => { assertRiskConfigForMode(); return new RiskService(); } },
  ],
  exports: [GameEngineService, BetsService],
})
export class GameModule {}
