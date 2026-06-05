import { test, expect, beforeEach, afterEach } from "bun:test";
import { ElectionService } from "../../src/ha/election.service";
import type { LeaderLock } from "../../src/ha/leader-lock";

// Phase 4.5a — ElectionService unit tests (design §6a). Direct-instantiation style
// (like test/engine-recovery.test.ts) with an IN-MEMORY LeaderLock stub, so we need
// no real second Postgres connection and no real timers — we drive tick()/beat()/
// assertStillLeader() directly and assert the state machine + events.

/**
 * A shared, in-memory leadership backend modelling exactly what the real
 * PgAdvisoryLock guarantees: ONE holder of the advisory lock at a time, and a single
 * monotonic fence bumped on each acquire. Multiple FakeLock handles share one Backend
 * so two ElectionService "nodes" genuinely contend (test 2 + the fence test).
 */
class Backend {
  holder: string | null = null; // who holds the advisory lock (null = free)
  fence = 0n;
  acquire(nodeId: string): bigint | null {
    if (this.holder !== null && this.holder !== nodeId) return null; // someone else holds it
    this.holder = nodeId;
    this.fence += 1n; // monotonic bump on every acquire
    return this.fence;
  }
  release(nodeId: string) {
    if (this.holder === nodeId) this.holder = null;
  }
}

class FakeLock implements LeaderLock {
  /** Flip to true to simulate a dead dedicated connection (heartbeat throws → demote). */
  connectionDead = false;
  closed = false;
  constructor(
    private readonly backend: Backend,
    private readonly nodeId: string,
  ) {}
  async tryAcquire(): Promise<bigint | null> {
    return this.backend.acquire(this.nodeId);
  }
  async heartbeat(): Promise<void> {
    if (this.connectionDead) throw new Error("connection terminated unexpectedly");
  }
  async currentFence(): Promise<bigint> {
    return this.backend.fence;
  }
  async release(): Promise<void> {
    this.backend.release(this.nodeId);
  }
  async close(): Promise<void> {
    this.closed = true;
    // closing the dead session also relinquishes the lock, like a torn-down pg session
    this.backend.release(this.nodeId);
  }
}

// Collect events without depending on timers.
function captureEvents(svc: ElectionService) {
  const acquired: bigint[] = [];
  let lost = 0;
  svc.events.on("leader-acquired", (f: bigint) => acquired.push(f));
  svc.events.on("leader-lost", () => (lost += 1));
  return {
    acquired,
    get lost() {
      return lost;
    },
  };
}

const created: ElectionService[] = [];
function make(backend: Backend, nodeId: string): ElectionService {
  const svc = new ElectionService(new FakeLock(backend, nodeId), nodeId);
  created.push(svc);
  return svc;
}

let savedAutostart: string | undefined;
beforeEach(() => {
  savedAutostart = process.env.GAME_AUTOSTART;
});
afterEach(async () => {
  // restore env + tear down any timers a test's onModuleInit may have started
  if (savedAutostart === undefined) delete process.env.GAME_AUTOSTART;
  else process.env.GAME_AUTOSTART = savedAutostart;
  for (const s of created.splice(0)) await s.onModuleDestroy().catch(() => {});
});

test("acquire when the lock is free → becomes leader, bumps the fence, fires leader-acquired", async () => {
  delete process.env.GAME_AUTOSTART; // eligible
  const backend = new Backend();
  const a = make(backend, "node-A");
  const ev = captureEvents(a);

  expect(a.isLeader()).toBe(false);
  await a.tick();

  expect(a.isLeader()).toBe(true);
  expect(a.fence).toBe(1n); // fence bumped from 0 → 1
  expect(ev.acquired).toEqual([1n]); // event carries the new fence
});

test("acquire when the lock is already held → stays follower, no leader-acquired", async () => {
  delete process.env.GAME_AUTOSTART;
  const backend = new Backend();
  const a = make(backend, "node-A");
  const b = make(backend, "node-B");

  await a.tick(); // A leads
  expect(a.isLeader()).toBe(true);

  const evB = captureEvents(b);
  await b.tick(); // B contends and loses

  expect(b.isLeader()).toBe(false);
  expect(b.fence).toBeNull();
  expect(evB.acquired).toEqual([]);
});

test("heartbeat throws (connection death) → demotes + fires leader-lost", async () => {
  delete process.env.GAME_AUTOSTART;
  const backend = new Backend();
  const a = make(backend, "node-A");
  const lock = (a as any).lock as FakeLock;
  const ev = captureEvents(a);

  await a.tick();
  expect(a.isLeader()).toBe(true);

  lock.connectionDead = true; // simulate the dedicated pg session dying
  await a.beat();

  expect(a.isLeader()).toBe(false);
  expect(a.fence).toBeNull();
  expect(ev.lost).toBe(1);
});

test("re-acquire after demotion → fence strictly increases (monotonic)", async () => {
  delete process.env.GAME_AUTOSTART;
  const backend = new Backend();
  const a = make(backend, "node-A");
  const lock = (a as any).lock as FakeLock;

  await a.tick();
  const first = a.fence;
  expect(first).toBe(1n);

  // lose leadership (dead connection), then close() frees the lock, then re-acquire
  lock.connectionDead = true;
  await a.beat();
  expect(a.isLeader()).toBe(false);

  lock.connectionDead = false; // connection recovered
  await a.tick(); // re-acquire
  expect(a.isLeader()).toBe(true);
  expect(a.fence).toBe(2n); // strictly greater than the first acquire
  expect(a.fence! > first!).toBe(true);
});

test("GAME_AUTOSTART=false → never participates (pure follower, never acquires)", async () => {
  process.env.GAME_AUTOSTART = "false";
  const backend = new Backend();
  const a = make(backend, "node-A");
  const ev = captureEvents(a);

  await a.onModuleInit(); // would normally start polling — must be a no-op here
  expect(a.isLeader()).toBe(false);

  // even an explicit tick() must not promote a non-participant... but tick() is the raw
  // mechanic; the guarantee is that onModuleInit never schedules it. Assert the lock was
  // never acquired by the lifecycle, and the backend is still free for a real node.
  expect(backend.holder).toBeNull();
  expect(ev.acquired).toEqual([]);

  // a genuinely eligible node can still take it (proves the lock itself wasn't touched)
  delete process.env.GAME_AUTOSTART;
  const b = make(backend, "node-B");
  await b.tick();
  expect(b.isLeader()).toBe(true);
  expect(b.fence).toBe(1n);
});

test("assertStillLeader() → false once another node advanced the fence (stale-leader)", async () => {
  delete process.env.GAME_AUTOSTART;
  const backend = new Backend();
  const a = make(backend, "node-A");

  await a.tick(); // A leads at fence 1
  expect(await a.assertStillLeader()).toBe(true); // still current

  // Simulate A losing the lock server-side (e.g. GC pause tore down its pg session) and
  // B winning: free the lock, then B acquires → fence advances to 2. A still *believes*
  // it leads (its in-memory `leader` flag is stale) but the fence moved past myFence.
  backend.release("node-A");
  const b = make(backend, "node-B");
  await b.tick();
  expect(b.fence).toBe(2n);

  // A's next phase-transition guard must detect it is stale and refuse to act.
  expect(a.isLeader()).toBe(true); // in-memory flag not yet updated...
  expect(await a.assertStillLeader()).toBe(false); // ...but the fence check catches it
});

test("assertStillLeader() → false when not leader at all", async () => {
  delete process.env.GAME_AUTOSTART;
  const backend = new Backend();
  const a = make(backend, "node-A");
  expect(await a.assertStillLeader()).toBe(false); // never acquired → false (fail-closed)
});
