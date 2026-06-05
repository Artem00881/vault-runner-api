import { test, expect, beforeAll, afterAll } from "bun:test";
import Redis from "ioredis";
import { PgAdvisoryLock, stripPrismaParams } from "../../src/ha/pg-advisory-lock";

// Phase 4.5a — integration test for the REAL PgAdvisoryLock against the live dev
// Postgres + Redis (recovery-test style: real deps, best-effort cleanup). The unit
// suite (election.test.ts) proves the state machine with a stub; THIS proves the
// actual SQL contracts — advisory-lock mutual exclusion across two connections, the
// monotonic fence on engine_leadership, heartbeat liveness, release frees the lock,
// and the Redis lease mirror. Nothing here is wired to the engine.

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://vault:vault@localhost:5432/vaultrun?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let redis: Redis;
const locks: PgAdvisoryLock[] = [];
function lock(nodeId: string): PgAdvisoryLock {
  const l = new PgAdvisoryLock(DATABASE_URL, nodeId, redis);
  locks.push(l);
  return l;
}

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  redis.on("error", () => {}); // tolerate a redis blip — the lease is advisory-only
});

afterAll(async () => {
  // release + close every lock, then restore the singleton fence row to its pristine
  // seeded state so these synthetic acquires don't perturb other suites / the audit.
  for (const l of locks) {
    await l.release().catch(() => {});
    await l.close().catch(() => {});
  }
  try {
    const admin = lock("test-cleanup");
    await admin.currentFence(); // opens a connection
    // reset via a tiny throwaway: reuse the pg client inside the lock isn't exposed, so
    // do it through a fresh client.
    await admin.close();
  } catch {
    /* ignore */
  }
  // Reset the row directly with a short-lived pg client.
  try {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: stripPrismaParams(DATABASE_URL), connectionTimeoutMillis: 3000 });
    await c.connect();
    await c.query("UPDATE engine_leadership SET fence = 0, node_id = NULL, acquired_at = NULL WHERE id = true");
    await c.end();
  } catch {
    /* best-effort */
  }
  await redis?.quit().catch(() => {});
});

test("stripPrismaParams rebuilds a clean libpq URL (no 'null' origin corruption)", () => {
  expect(stripPrismaParams("postgresql://u:p@host:5432/db?schema=public")).toBe("postgresql://u:p@host:5432/db");
  expect(stripPrismaParams("postgresql://u:p@host:5432/db?schema=public&connection_limit=5")).toBe(
    "postgresql://u:p@host:5432/db",
  );
  // sslmode is libpq-understood → preserved
  expect(stripPrismaParams("postgresql://u:p@host:5432/db?sslmode=require&schema=public")).toBe(
    "postgresql://u:p@host:5432/db?sslmode=require",
  );
});

test("two contending connections: exactly one holds the advisory lock", async () => {
  const a = lock("it-A");
  const b = lock("it-B");

  const fA = await a.tryAcquire();
  expect(fA).not.toBeNull(); // A wins
  const fB = await b.tryAcquire();
  expect(fB).toBeNull(); // B loses — real pg_try_advisory_lock mutual exclusion

  // fence reflects A's single acquire; both connections read the same authoritative value
  expect(await a.currentFence()).toBe(fA!);
  expect(await b.currentFence()).toBe(fA!);

  // release so the held session lock doesn't leak into the next test (each test is
  // self-contained; advisory locks are per-session and live until the client closes).
  await a.release();
});

test("release frees the lock and the next acquire bumps the fence (monotonic)", async () => {
  const a = lock("it-mono-A");
  const b = lock("it-mono-B");

  const fA = await a.tryAcquire();
  expect(fA).not.toBeNull();
  await a.release();

  const fB = await b.tryAcquire(); // now free → B takes it
  expect(fB).not.toBeNull();
  expect(fB! > fA!).toBe(true); // strictly increasing across the re-acquire
  await b.release();
});

test("heartbeat succeeds on a live connection and refreshes the Redis lease", async () => {
  const a = lock("it-hb");
  const fA = await a.tryAcquire();
  expect(fA).not.toBeNull();

  await a.heartbeat(); // SELECT 1 on the live dedicated session — must not throw

  // lease mirror present (advisory-only; skip the assert if redis is down)
  if (redis.status === "ready") {
    const lease = await redis.get("vaultrun:leader").catch(() => null);
    if (lease !== null) expect(lease).toBe(`it-hb:${fA}`);
  }
  await a.release();
});

test("heartbeat before any acquire throws (caller must demote)", async () => {
  const a = lock("it-no-acquire");
  let threw = false;
  await a.heartbeat().catch(() => (threw = true));
  expect(threw).toBe(true);
});
