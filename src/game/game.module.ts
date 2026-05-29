import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { RedisModule } from "../redis/redis.module";
import { FairnessModule } from "../fairness/fairness.module";
import { GameEngineService } from "./game-engine.service";
import { RoundsController } from "./rounds.controller";

@Module({
  imports: [PrismaModule, RedisModule, FairnessModule],
  controllers: [RoundsController],
  providers: [GameEngineService],
  exports: [GameEngineService],
})
export class GameModule {}
