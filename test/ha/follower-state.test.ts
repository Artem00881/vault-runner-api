import { test, expect } from "bun:test";
import { PublicRoundCache, type PublishedRoundState } from "../../src/game/public-round-cache";
import { GROWTH, GameEngineService } from "../../src/game/game-engine.service";

/**
 * Phase 4.5b — follower public-state correctness (design §3). PURE: construct the
 * PublicRoundCache directly, feed it leader-published payloads via the private ingest(),
 * and assert the follower computes the live multiplier locally and NEVER holds crashPoint.
 * Also assert the engine's follower path delegates getPublicState()/currentMultiplier() to
 * the cache when not leader, so a manual cash-out on a follower returns the real multiplier
 * (the bug was: with no engine loop it returned 1.0).
 */

const redisStub: any = { duplicate: () => ({ on() {}, subscribe: async () => {}, quit: async () => {} }), client: { get: async () => null } };

function cacheWith(payload: PublishedRoundState): PublicRoundCache {
  const c = new PublicRoundCache({ ...redisStub } as any);
  (c as any).ingest(JSON.stringify(payload));
  return c;
}

const expectedRunningMult = (startedAt: number, now: number) =>
  Math.max(1.0, Math.floor(Math.exp(GROWTH * (now - startedAt)) * 100) / 100);

test("follower computes the live RUNNING multiplier locally from startedAt (matches the engine formula)", () => {
  const startedAt = Date.now() - 5000; // 5s into the run
  const cache = cacheWith({
    roundId: "r1",
    phase: "running",
    phaseEndsAt: startedAt + 60_000,
    multiplier: 1.0, // leader-published value is stale; the follower recomputes locally
    serverTime: startedAt,
    startedAt,
    seedId: "seed-1",
  });
  const now = Date.now();
  const m = cache.currentMultiplier();
  // within one tick of the exact formula (now advanced a hair between the two Date.now()s)
  expect(Math.abs(m - expectedRunningMult(startedAt, now))).toBeLessThanOrEqual(0.01);
  expect(m).toBeGreaterThan(1.0); // 5s of growth is clearly > 1.0
});

test("follower view STRUCTURALLY has no crashPoint property (even if the payload smuggles one)", () => {
  const startedAt = Date.now() - 1000;
  const cache = cacheWith({
    roundId: "r2",
    phase: "running",
    phaseEndsAt: startedAt + 60_000,
    multiplier: 1.5,
    serverTime: startedAt,
    startedAt,
    seedId: "seed-2",
    // a hostile/buggy publish tries to leak the secret crash — must NOT land in the view
    ...({ crashPoint: 7.77 } as any),
  });
  const view = cache.getView()!;
  expect(Object.keys(view)).not.toContain("crashPoint");
  expect((view as any).crashPoint).toBeUndefined();
  // and the public state it serves also has no crashPoint key
  const pub = cache.getPublicState()!;
  expect(Object.keys(pub)).not.toContain("crashPoint");
});

test("follower returns the PUBLISHED multiplier post-crash (= revealed crashPoint, already public)", () => {
  const cache = cacheWith({
    roundId: "r3",
    phase: "crashed",
    phaseEndsAt: Date.now() + 2500,
    multiplier: 4.2, // the revealed crash multiplier the leader published
    serverTime: Date.now(),
    startedAt: Date.now() - 12_000,
    seedId: "seed-3",
  });
  expect(cache.currentMultiplier()).toBe(4.2); // serves the leader's published value, not a local recompute
  expect(cache.getPublicState()!.phase).toBe("crashed");
});

test("follower pre-running returns 1.0 (waiting/betting)", () => {
  for (const phase of ["waiting", "betting"] as const) {
    const cache = cacheWith({
      roundId: "r4",
      phase,
      phaseEndsAt: Date.now() + 3000,
      multiplier: 1.0,
      serverTime: Date.now(),
      startedAt: null,
      seedId: "seed-4",
    });
    expect(cache.currentMultiplier()).toBe(1.0);
  }
});

test("empty cache (nothing published yet) → getPublicState null, multiplier 1.0", () => {
  const c = new PublicRoundCache({ ...redisStub } as any);
  expect(c.getPublicState()).toBeNull();
  expect(c.currentMultiplier()).toBe(1.0);
});

test("engine in FOLLOWER mode delegates getPublicState/currentMultiplier to the cache (cash-out reads real multiplier)", () => {
  const startedAt = Date.now() - 4000;
  const cache = cacheWith({
    roundId: "r5",
    phase: "running",
    phaseEndsAt: startedAt + 60_000,
    multiplier: 1.0,
    serverTime: startedAt,
    startedAt,
    seedId: "seed-5",
  });
  // Election stub that reports FOLLOWER — the engine must read the cache, not this.state.
  const followerElection: any = { isLeader: () => false, assertStillLeader: async () => false, fence: null, events: { on() {} } };
  const engine = new GameEngineService(
    {} as any,
    redisStub,
    {} as any,
    {} as any,
    {} as any,
    followerElection,
    cache,
  );
  // The engine has NO in-memory state (never ran the loop) — pre-4.5b this returned 1.0.
  const pub = engine.getPublicState()!;
  expect(pub).not.toBeNull();
  expect(pub.roundId).toBe("r5");
  expect(pub.phase).toBe("running");
  expect(engine.currentMultiplier()).toBeGreaterThan(1.0); // the FIX: real climbing multiplier on a follower
});
