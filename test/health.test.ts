import { test, expect, afterEach } from "bun:test";
import { HttpException } from "@nestjs/common";
import { HealthController } from "../src/health/health.controller";

// METRICS_TOKEN is read from process.env at call time and the bun test process
// is SHARED across files — restore it after every test so the detail-gating
// cases below can never leak a token into another file (audit H5 env hygiene).
const SAVED_METRICS_TOKEN = process.env.METRICS_TOKEN;
afterEach(() => {
  if (SAVED_METRICS_TOKEN === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = SAVED_METRICS_TOKEN;
});

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

// A fake request carrying an Authorization header (what health(@Req()) reads).
function reqWith(authorization?: string): any {
  return { headers: { authorization } };
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

// ── H5: detail gating when METRICS_TOKEN is SET ──────────────────────────────
// The deep body (deps/service/uptimeMs) is info-disclosure; expose only to a
// caller bearing the token. The 200/503 decision is unchanged.

test("H5: token set + no/wrong bearer → public body is just {status} (no deps)", async () => {
  process.env.METRICS_TOKEN = "metrics-secret";
  const c = makeController({ dbUp: true, redisUp: true, engine: { phase: "betting" } });

  // No request at all (e.g. internal call without headers).
  const noReq: any = await c.health();
  expect(noReq.status).toBe("ok");
  expect(noReq.deps).toBeUndefined();
  expect(noReq.service).toBeUndefined();
  expect(noReq.uptimeMs).toBeUndefined();
  expect(noReq.ts).toBeUndefined();

  // Wrong / non-Bearer header → still gated.
  const wrong: any = await c.health(reqWith("Bearer not-the-token"));
  expect(wrong.status).toBe("ok");
  expect(wrong.deps).toBeUndefined();

  const nonBearer: any = await c.health(reqWith("Basic metrics-secret"));
  expect(nonBearer.status).toBe("ok");
  expect(nonBearer.deps).toBeUndefined();
});

test("H5: token set + correct bearer → full deps present", async () => {
  process.env.METRICS_TOKEN = "metrics-secret";
  const c = makeController({ dbUp: true, redisUp: true, engine: { phase: "betting" } });
  const r: any = await c.health(reqWith("Bearer metrics-secret"));
  expect(r.status).toBe("ok");
  expect(r.service).toBe("vault-runner-api");
  expect(typeof r.uptimeMs).toBe("number");
  expect(r.deps.db.up).toBe(true);
  expect(r.deps.redis.up).toBe(true);
  expect(r.deps.engine.running).toBe(true);
  expect(r.deps.engine.phase).toBe("betting");
});

test("H5: 503 path still throws {status:degraded} with NO deps when unauthed", async () => {
  process.env.METRICS_TOKEN = "metrics-secret";
  const c = makeController({ dbUp: true, redisUp: false, engine: null });
  try {
    await c.health(reqWith("Bearer wrong")); // unauthed → no detail
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    const ex = e as HttpException;
    expect(ex.getStatus()).toBe(503); // 200/503 decision unchanged
    const body = ex.getResponse() as any;
    expect(body.status).toBe("degraded");
    expect(body.deps).toBeUndefined(); // detail withheld from unauthed caller
    expect(body.service).toBeUndefined();
  }
});

test("H5: 503 path WITH correct bearer still exposes per-dep detail", async () => {
  process.env.METRICS_TOKEN = "metrics-secret";
  const c = makeController({ dbUp: true, redisUp: false, engine: null });
  try {
    await c.health(reqWith("Bearer metrics-secret"));
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    const body = (e as HttpException).getResponse() as any;
    expect(body.status).toBe("degraded");
    expect(body.deps.redis.up).toBe(false);
    expect(body.deps.db.up).toBe(true);
  }
});
