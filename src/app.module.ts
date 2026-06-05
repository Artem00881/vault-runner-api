import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { IpThrottlerGuard } from "./common/ip-throttler.guard";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { AuthModule } from "./auth/auth.module";
import { WalletModule } from "./wallet/wallet.module";
import { FairnessModule } from "./fairness/fairness.module";
import { GameModule } from "./game/game.module";
import { HaModule } from "./ha/ha.module";
import { LeaderboardModule } from "./leaderboard/leaderboard.module";
import { OperatorModule } from "./operator/operator.module";
import { MetricsModule } from "./metrics/metrics.module";
import { HealthController } from "./health/health.controller";
import { CurrencyController } from "./common/currency.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      {
        // Tunable per environment (prod default 120/min/IP); raise for load tests.
        ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
        limit: Number(process.env.THROTTLE_LIMIT ?? 120),
      },
    ]),
    PrismaModule,
    RedisModule,
    AuthModule,
    WalletModule,
    FairnessModule,
    HaModule, // engine leader election (Phase 4.5b) — drives engine start/stop
    GameModule,
    LeaderboardModule,
    OperatorModule,
    MetricsModule,
  ],
  controllers: [HealthController, CurrencyController],
  providers: [{ provide: APP_GUARD, useClass: IpThrottlerGuard }],
})
export class AppModule {}
