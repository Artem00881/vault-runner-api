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

  /**
   * Ping a dependency with a hard timeout so a HUNG dependency fails fast as
   * "down" instead of hanging the whole /health response (Phase 4.0). The Redis
   * client uses `maxRetriesPerRequest`, so a down Redis would otherwise queue +
   * retry the ping rather than reject promptly → `Promise.all` never resolves →
   * the LB/monitor sees a hang (`000`) instead of a clean 503. `Promise.race`
   * keeps a reaction attached to the slow `fn()`, so its late rejection is
   * consumed (no unhandled rejection); the timer is always cleared.
   */
  private async ping<T>(
    fn: () => Promise<T>,
    timeoutMs = 800,
  ): Promise<{ up: boolean; latencyMs: number; error?: string }> {
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      return { up: true, latencyMs: Date.now() - t0 };
    } catch (e: any) {
      return { up: false, latencyMs: Date.now() - t0, error: e?.message ?? "error" };
    } finally {
      if (timer) clearTimeout(timer);
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

  /**
   * F-051 — engine LIVENESS probe (multi-node profile). Distinct from GET /health on purpose:
   *
   *  - GET /health is the LB/WS-rotation probe and stays ENGINE-AGNOSTIC: a node whose engine
   *    is merely off (follower / GAME_AUTOSTART=false) is still perfectly able to serve WS, so
   *    it must NOT be pulled from rotation. /health only fails on a dep (DB/Redis) outage.
   *
   *  - GET /health/live is for an ORCHESTRATOR (Docker/K8s) restart decision: it FAILS (503)
   *    only when THIS node is the engine LEADER and the round loop has stalled (no round
   *    completed within LIVE_STALL_MS). A stalled leader SHOULD fail over — failing this probe
   *    tells the orchestrator to restart the container, which drops the advisory lock and lets
   *    a follower take over. A follower / non-leader always passes (it owns no loop to stall).
   *
   * Gated behind a leader-stall so it is a no-op on a healthy leader and on every follower.
   * The deadman (F-048c) self-heals first via voluntary step-down; this probe is the
   * orchestration-level backstop. SINGLE-NODE PROD IS UNCHANGED: the Docker healthcheck that
   * targets this is shipped commented / multi-node-only (docker-compose.prod.yml), so today
   * nothing acts on it — it is a read-only endpoint until the multi-node cutover wires it.
   */
  @Get("live")
  live() {
    const LIVE_STALL_MS = Number(process.env.ENGINE_LIVE_STALL_MS ?? 120_000); // 2 min default
    let leader = false;
    let sinceLastRoundMs: number | null = null;
    try {
      leader = this.engine.isEngineLeader();
      sinceLastRoundMs = this.engine.msSinceLastRound();
    } catch {
      // Engine not introspectable → treat as not-a-leader (don't fail liveness on that).
      leader = false;
    }
    const stalled = leader && sinceLastRoundMs !== null && sinceLastRoundMs > LIVE_STALL_MS;
    const body = { status: stalled ? "stalled" : "ok", leader, sinceLastRoundMs };
    if (stalled) throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
