import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { RedisModule } from "../redis/redis.module";
import { FairnessModule } from "../fairness/fairness.module";
import { WalletModule } from "../wallet/wallet.module";
import { AuthModule } from "../auth/auth.module";
import { GameEngineService } from "./game-engine.service";
import { GameGateway } from "./game.gateway";
import { BetsService } from "./bets.service";
import { RoundsController } from "./rounds.controller";

@Module({
  imports: [PrismaModule, RedisModule, FairnessModule, WalletModule, AuthModule],
  controllers: [RoundsController],
  providers: [GameEngineService, GameGateway, BetsService],
  exports: [GameEngineService, BetsService],
})
export class GameModule {}
