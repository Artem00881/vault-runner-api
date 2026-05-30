import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { AuthModule } from "./auth/auth.module";
import { WalletModule } from "./wallet/wallet.module";
import { FairnessModule } from "./fairness/fairness.module";
import { GameModule } from "./game/game.module";
import { LeaderboardModule } from "./leaderboard/leaderboard.module";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    AuthModule,
    WalletModule,
    FairnessModule,
    GameModule,
    LeaderboardModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
