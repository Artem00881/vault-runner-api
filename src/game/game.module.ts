import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { RedisModule } from "../redis/redis.module";
import { FairnessModule } from "../fairness/fairness.module";
import { WalletModule } from "../wallet/wallet.module";
import { AuthModule } from "../auth/auth.module";
import { OperatorModule } from "../operator/operator.module";
import { HaModule } from "../ha/ha.module";
import { GameEngineService } from "./game-engine.service";
import { GameGateway } from "./game.gateway";
import { BetsService } from "./bets.service";
import { PublicRoundCache } from "./public-round-cache";
import { RiskService, assertRiskConfigForMode } from "./risk.service";
import { RoundsController } from "./rounds.controller";
import { BetsController } from "./bets.controller";
import { OperatorBetsController } from "./operator-bets.controller";

@Module({
  // HaModule exports ElectionService (engine + gateway inject it for leadership).
  // HaModule imports ONLY RedisModule — it must NOT import GameModule (no cycle).
  imports: [PrismaModule, RedisModule, FairnessModule, WalletModule, AuthModule, OperatorModule, HaModule],
  controllers: [RoundsController, BetsController, OperatorBetsController],
  providers: [
    GameEngineService,
    GameGateway,
    BetsService,
    PublicRoundCache, // follower public-state mirror (Phase 4.5b)
    // Fail CLOSED at boot in operator/real-money mode if the RISK_* ceilings are still
    // demo-grade defaults (go-live guard, mirrors fairness.module's salt guard).
    { provide: RiskService, useFactory: () => { assertRiskConfigForMode(); return new RiskService(); } },
  ],
  exports: [GameEngineService, BetsService],
})
export class GameModule {}
