import { test, expect, beforeEach, afterEach } from "bun:test";
import { ElectionService } from "../../src/ha/election.service";
import type { LeaderLock } from "../../src/ha/leader-lock";

/**
 * Audit H5 / F-048c — ElectionService.stepDown() (the voluntary step-down the engine-stall
 * deadman calls). It must reuse the EXISTING money-safe demotion: explicitly RELEASE the
 * advisory lock, then demote (leader=false, fence cleared, `leader-lost` fired so the engine
 * stops), and free the lock so a follower can acquire and resume via the proven failover path.
 *
 * In-memory LeaderLock stub (a Backend models the single-holder advisory lock + monotonic
 * fence), mirroring test/ha/election.test.ts. We assert release() was called, leadership was
 * relinquished, the event fired, and a SECOND contender can then take the freed lock.
 */

class Backend {
  holder: string | null = null;
  fence = 0n;
  acquire(nodeId: string): bigint | null {
    if (this.holder !== null && this.holder !== nodeId) return null;
    this.holder = nodeId;
    this.fence += 1n;
    return this.fence;
  }
  release(nodeId: string) {
    if (this.holder === nodeId) this.holder = null;
  }
}

class FakeLock implements LeaderLock {
  released = 0;
  closed = 0;
  constructor(
    private readonly backend: Backend,
    private readonly nodeId: string,
  ) {}
  async tryAcquire(): Promise<bigint | null> {
    return this.backend.acquire(this.nodeId);
  }
  async heartbeat(): Promise<void> {}
  async currentFence(): Promise<bigint> {
    return this.backend.fence;
  }
  async release(): Promise<void> {
    this.released++;
    this.backend.release(this.nodeId);
  }
  async close(): Promise<void> {
    this.closed++;
    this.backend.release(this.nodeId);
  }
}

const created: ElectionService[] = [];
function make(backend: Backend, nodeId: string): { svc: ElectionService; lock: FakeLock } {
  const lock = new FakeLock(backend, nodeId);
  const svc = new ElectionService(lock, nodeId);
  created.push(svc);
  return { svc, lock };
}

let savedAutostart: string | undefined;
beforeEach(() => {
  savedAutostart = process.env.GAME_AUTOSTART;
  delete process.env.GAME_AUTOSTART; // eligible
});
afterEach(async () => {
  if (savedAutostart === undefined) delete process.env.GAME_AUTOSTART;
  else process.env.GAME_AUTOSTART = savedAutostart;
  for (const s of created.splice(0)) await s.onModuleDestroy().catch(() => {});
});

test("stepDown() releases the lock, demotes, fires leader-lost, and frees the lock for a follower", async () => {
  const backend = new Backend();
  const { svc: a, lock: lockA } = make(backend, "node-A");
  let lost = 0;
  a.events.on("leader-lost", () => (lost += 1));

  await a.tick(); // A leads at fence 1
  expect(a.isLeader()).toBe(true);
  expect(backend.holder).toBe("node-A");

  await a.stepDown("engine-stall-deadman");

  expect(lockA.released).toBe(1); // explicit advisory-unlock happened
  expect(a.isLeader()).toBe(false); // demoted
  expect(a.fence).toBeNull(); // fence cleared
  expect(lost).toBe(1); // leader-lost fired → engine.stop()
  expect(backend.holder).toBeNull(); // lock freed

  // a healthy follower can now take over (the failover the deadman wanted).
  const { svc: b } = make(backend, "node-B");
  await b.tick();
  expect(b.isLeader()).toBe(true);
  expect(b.fence! > 1n).toBe(true); // fence advanced — monotonic
});

test("stepDown() is a no-op when not the leader", async () => {
  const backend = new Backend();
  const { svc: a, lock: lockA } = make(backend, "node-A"); // never acquired
  let lost = 0;
  a.events.on("leader-lost", () => (lost += 1));

  await a.stepDown("test");

  expect(lockA.released).toBe(0);
  expect(lost).toBe(0);
  expect(a.isLeader()).toBe(false);
});
