import { Controller, Get, Inject, HttpException, HttpStatus, Req } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { GameEngineService } from "../game/game-engine.service";
import { bearerToken, safeTokenEqual } from "../common/timing-safe";

/**
 * Deep liveness check (Phase 1.2). Pings each critical dependency so a load
 * balancer / monitor can tell a genuinely-healthy node from one that merely
 * "responds". Returns 200 only when DB + Redis are up; 503 otherwise, with a
 * per-dependency status so we can see WHAT broke.
 *
 * The engine is reported but does NOT fail health on its own: it can be
 * intentionally off (GAME_AUTOSTART=false) without the node being unhealthy.
 */
@Controller("health")
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(GameEngineService) private readonly engine: GameEngineService,
  ) {}

  private async ping<T>(fn: () => Promise<T>): Promise<{ up: boolean; latencyMs: number; error?: string }> {
    const t0 = Date.now();
    try {
      await fn();
      return { up: true, latencyMs: Date.now() - t0 };
    } catch (e: any) {
      return { up: false, latencyMs: Date.now() - t0, error: e?.message ?? "error" };
    }
  }

  @Get()
  async health(@Req() req?: any) {
    const [db, redis] = await Promise.all([
      this.ping(() => this.prisma.$queryRaw`SELECT 1`),
      this.ping(() => this.redis.client.ping()),
    ]);

    const state = (() => {
      try {
        return this.engine.getPublicState();
      } catch {
        return null;
      }
    })();
    const engine = { running: !!state, phase: state?.phase ?? null };
    const healthy = db.up && redis.up; // engine is informational only

    // The detailed body (deps + their error strings/hostnames, uptime) is an
    // info-disclosure surface (audit H5). Expose it only to a caller bearing the
    // METRICS_TOKEN; the public body is just {status}. When the token is unset
    // (local/CI) keep full detail so dev/debugging + existing tests are unaffected.
    // The 200/503 decision is unchanged, so any healthcheck on the status code works.
    const token = process.env.METRICS_TOKEN;
    const showDetail = !token || safeTokenEqual(bearerToken(req?.headers?.authorization), token);
    const detail = showDetail
      ? {
          service: "vault-runner-api",
          uptimeMs: Date.now() - this.startedAt,
          ts: new Date().toISOString(),
          deps: { db, redis, engine },
        }
      : {};

    if (healthy) return { status: "ok", ...detail };
    throw new HttpException({ status: "degraded", ...detail }, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
