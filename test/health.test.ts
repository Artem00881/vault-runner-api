import { test, expect } from "bun:test";
import { HttpException } from "@nestjs/common";
import { HealthController } from "../src/health/health.controller";

// Minimal fakes — health just needs $queryRaw / client.ping / getPublicState.
function makeController(opts: { dbUp: boolean; redisUp: boolean; engine: any }) {
  const prisma: any = {
    $queryRaw: async () => { if (!opts.dbUp) throw new Error("db down"); return [{ "?column?": 1 }]; },
  };
  const redis: any = {
    client: { ping: async () => { if (!opts.redisUp) throw new Error("redis down"); return "PONG"; } },
  };
  const engine: any = { getPublicState: () => opts.engine };
  return new HealthController(prisma, redis, engine);
}

test("healthy: db + redis up → status ok with deps", async () => {
  const c = makeController({ dbUp: true, redisUp: true, engine: { phase: "betting" } });
  const r: any = await c.health();
  expect(r.status).toBe("ok");
  expect(r.deps.db.up).toBe(true);
  expect(r.deps.redis.up).toBe(true);
  expect(r.deps.engine.running).toBe(true);
  expect(r.deps.engine.phase).toBe("betting");
});

test("degraded: redis down → throws 503 with per-dep detail", async () => {
  const c = makeController({ dbUp: true, redisUp: false, engine: null });
  try {
    await c.health();
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    const ex = e as HttpException;
    expect(ex.getStatus()).toBe(503);
    const body = ex.getResponse() as any;
    expect(body.status).toBe("degraded");
    expect(body.deps.redis.up).toBe(false);
    expect(body.deps.db.up).toBe(true);
  }
});

test("engine off (autostart=false) does NOT fail health", async () => {
  const c = makeController({ dbUp: true, redisUp: true, engine: null });
  const r: any = await c.health();
  expect(r.status).toBe("ok"); // healthy despite engine not running
  expect(r.deps.engine.running).toBe(false);
});
