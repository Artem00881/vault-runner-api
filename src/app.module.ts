import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
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
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]), // 120 req/min/IP
    PrismaModule,
    RedisModule,
    AuthModule,
    WalletModule,
    FairnessModule,
    GameModule,
    LeaderboardModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
