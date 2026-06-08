import { Module } from "@nestjs/common";
import { RedisModule } from "../redis/redis.module";
import { RedisService } from "../redis/redis.service";
import { ElectionService } from "./election.service";
import { PgAdvisoryLock } from "./pg-advisory-lock";
import type { LeaderLock } from "./leader-lock";

/**
 * Engine HA module (Phase 4.5a primitives, WIRED LIVE since Phase 4.5b).
 *
 * WIRED: imported by AppModule (and via GameModule), so `ElectionService` is
 * constructed at boot and the engine drives start()/stop() off its
 * `leader-acquired`/`leader-lost` events (see game-engine.service.ts onModuleInit).
 * The 4.5b wiring landed with the money-path-auditor / fairness-verifier sign-off.
 * NOTE: prod runs SINGLE-NODE — one node simply wins the lock on boot and starts the
 * loop, so the net single-node behaviour is unchanged from the pre-4.5b code path; the
 * election machinery is what makes a multi-node deploy seamless-failover-safe.
 *
 * The factory builds the real `PgAdvisoryLock`: a DEDICATED `pg.Client` from
 * DATABASE_URL (never the pooled Prisma client) + the shared Redis client as the
 * advisory lease mirror.
 */
@Module({
  imports: [RedisModule],
  providers: [
    {
      provide: ElectionService,
      inject: [RedisService],
      useFactory: (redis: RedisService) => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error("HaModule: DATABASE_URL is required for the engine leader lock");
        const lock: LeaderLock = new PgAdvisoryLock(url, hostNodeId(), redis.client);
        return new ElectionService(lock);
      },
    },
  ],
  exports: [ElectionService],
})
export class HaModule {}

/** Stable-ish per-process node id for logs / the fence row / the Redis lease. */
function hostNodeId(): string {
  const host = process.env.HOSTNAME ?? "node";
  return `${host}-${process.pid}`;
}
