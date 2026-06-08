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
// `redisHang` models a DOWN redis whose client queues+retries (maxRetriesPerRequest)
// so ping() never settles — the Phase 4.0 timeout path under test.
function makeController(opts: { dbUp: boolean; redisUp: boolean; engine: any; redisHang?: boolean }) {
  const prisma: any = {
    $queryRaw: async () => { if (!opts.dbUp) throw new Error("db down"); return [{ "?column?": 1 }]; },
  };
  const redis: any = {
    client: {
      ping: () => {
        if (opts.redisHang) return new Promise<string>(() => {}); // never settles
        return Promise.resolve().then(() => { if (!opts.redisUp) throw new Error("redis down"); return "PONG"; });
      },
    },
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

// ── Phase 4.0: HUNG dependency must fail fast (Promise.race timeout) ─────────
// A down Redis whose client queues+retries would make ping() never settle, so
// without the ~800ms timeout the whole Promise.all (and /health) would hang and
// the LB would see `000` instead of a clean 503. Assert it settles well under
// the wall-clock ceiling, throws 503, and reports redis down (timeout) / db up.
test("Phase 4.0: hung redis ping fails fast as 503 (does not hang health)", async () => {
  // METRICS_TOKEN unset (afterEach restores) → full detail is shown.
  delete process.env.METRICS_TOKEN;
  const c = makeController({ dbUp: true, redisUp: false, redisHang: true, engine: null });

  const t0 = Date.now();
  let threw: unknown;
  try {
    await c.health();
  } catch (e) {
    threw = e;
  }
  const elapsed = Date.now() - t0;

  // Settled fast: the 800ms timeout fired, NOT a hang. Generous ceiling well
  // below any "hang" but comfortably above the 800ms default + scheduling jitter.
  expect(elapsed).toBeLessThan(2000);
  // And it actually waited for the timeout rather than resolving instantly.
  expect(elapsed).toBeGreaterThanOrEqual(700);

  // Unhealthy → 503 HttpException (degraded).
  expect(threw).toBeInstanceOf(HttpException);
  const ex = threw as HttpException;
  expect(ex.getStatus()).toBe(503);
  const body = ex.getResponse() as any;
  expect(body.status).toBe("degraded");
  // redis down with a timeout-ish error; db unaffected.
  expect(body.deps.redis.up).toBe(false);
  expect(body.deps.redis.error).toMatch(/timeout/i);
  expect(body.deps.db.up).toBe(true);
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

// ── F-051: GET /health/live — engine-LIVENESS probe (multi-node orchestration) ───────────────
// Distinct from /health: it FAILS (503) only when THIS node is the engine LEADER and the loop
// has stalled (no round within ENGINE_LIVE_STALL_MS). A follower / non-leader always passes, so
// it never pulls a healthy WS node from rotation. (The Docker healthcheck targeting it is
// shipped commented / multi-node-only, so single-node prod is unaffected.)
const SAVED_LIVE_STALL = process.env.ENGINE_LIVE_STALL_MS;
afterEach(() => {
  if (SAVED_LIVE_STALL === undefined) delete process.env.ENGINE_LIVE_STALL_MS;
  else process.env.ENGINE_LIVE_STALL_MS = SAVED_LIVE_STALL;
});

function liveController(engine: { isEngineLeader: () => boolean; msSinceLastRound: () => number }) {
  const prisma: any = { $queryRaw: async () => [{ "?column?": 1 }] };
  const redis: any = { client: { ping: async () => "PONG" } };
  return new HealthController(prisma, redis, engine as any);
}

test("F-051 /health/live: a healthy leader (fresh round) → 200 ok", () => {
  process.env.ENGINE_LIVE_STALL_MS = "120000";
  const c = liveController({ isEngineLeader: () => true, msSinceLastRound: () => 5_000 });
  const r: any = c.live();
  expect(r.status).toBe("ok");
  expect(r.leader).toBe(true);
});

test("F-051 /health/live: a STALLED leader → 503 (orchestrator should restart → failover)", () => {
  process.env.ENGINE_LIVE_STALL_MS = "120000";
  const c = liveController({ isEngineLeader: () => true, msSinceLastRound: () => 300_000 });
  try {
    c.live();
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    const ex = e as HttpException;
    expect(ex.getStatus()).toBe(503);
    expect((ex.getResponse() as any).status).toBe("stalled");
  }
});

test("F-051 /health/live: a FOLLOWER never fails, even with a stale lastRound", () => {
  process.env.ENGINE_LIVE_STALL_MS = "120000";
  const c = liveController({ isEngineLeader: () => false, msSinceLastRound: () => 999_999 });
  const r: any = c.live(); // follower owns no loop → liveness is always ok
  expect(r.status).toBe("ok");
  expect(r.leader).toBe(false);
});

test("F-051 /health/live: engine not introspectable → treated as not-leader → 200", () => {
  // engine throws on the calls (e.g. mid-boot) — must NOT fail liveness on that.
  const c = liveController({
    isEngineLeader: () => {
      throw new Error("not ready");
    },
    msSinceLastRound: () => 0,
  });
  const r: any = c.live();
  expect(r.status).toBe("ok");
  expect(r.leader).toBe(false);
});
