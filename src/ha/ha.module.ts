import { Module } from "@nestjs/common";
import { RedisModule } from "../redis/redis.module";
import { RedisService } from "../redis/redis.service";
import { ElectionService } from "./election.service";
import { PgAdvisoryLock } from "./pg-advisory-lock";
import type { LeaderLock } from "./leader-lock";

/**
 * Phase 4.5a — engine HA module.
 *
 * INTENTIONALLY NOT IMPORTED into AppModule in 4.5a. The primitives (ElectionService
 * + the Postgres advisory `LeaderLock`) exist, are unit-tested, and are ready to wire,
 * but importing this would start election + change start/stop semantics — that is 4.5b,
 * which needs the money-path-auditor / fairness-verifier sign-off. Leaving it unimported
 * keeps the running single-node game byte-for-byte unchanged.
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
