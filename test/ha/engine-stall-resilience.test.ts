import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";

/**
 * Audit H5 / F-048 (+ F-049, the F-076 chain gate) — ENGINE-STALL RESILIENCE regression suite.
 *
 * The live incident: the shared round loop awaited a phase that never settled (a wedged
 * dependency / hung await), with NO crash + NO error — the engine silently stopped producing
 * rounds and only a manual container restart recovered it. This suite proves the composed fix
 * self-heals WITHOUT a human, and that the stall is now observable:
 *
 *   1. HUNG-TRANSITION (F-048a + F-049): a phase fn that NEVER settles is raced against the
 *      per-phase deadline → it REJECTS → safe()'s catch records the `phase_transition` error
 *      metric (F-049, so ErrorSpike can fire) AND reschedules a fresh enterWaiting() within the
 *      deadline (F-048a self-heal). Previously this hung forever and emitted nothing.
 *
 *   2. DEADMAN SELF-DEMOTE (F-048c): a LEADER whose last round is older than the deadman window
 *      records the `engine_stall` error metric and VOLUNTARILY steps down via election.stepDown
 *      — the SAME clean lock-release path a dead heartbeat uses, so a follower takes over through
 *      the PROVEN failover-resume. A follower (non-leader) is a no-op, and the check fires once.
 *
 * Style mirrors test/ha/engine-leadership.test.ts + test/ha/failover-resume.test.ts
 * (direct-instantiation, controllable stubs). The hung-transition path touches NO DB (the
 * injected fn never resolves and enterWaiting is stubbed), so a Prisma stub suffices and the
 * test is deterministic + fast. The deadline/deadman windows are set tiny via env per-run
 * (the engine reads them at use time), then restored in afterEach.
 */

// ---- a metrics spy: records every recordError(where) so we can assert the stall signals ----
function makeMetrics() {
  const errors: string[] = [];
  return {
    errors,
    recordError: (where: string) => errors.push(where),
    recordRound: () => {},
    setEngineLeader: () => {},
    // anything else the engine might touch is a no-op
  } as any;
}

// ---- a controllable election: flippable leader + a spy on stepDown ----
function makeElection(initialLeader: boolean) {
  const events = new EventEmitter();
  const state = { leader: initialLeader, stepDowns: 0, lastReason: "" };
  return {
    events,
    state,
    nodeId: "node-test",
    isLeader: () => state.leader,
    assertStillLeader: async () => state.leader,
    stepDown: async (reason: string) => {
      state.stepDowns++;
      state.lastReason = reason;
      // model the real stepDown: demote + fire leader-lost (which the engine listens to)
      state.leader = false;
      events.emit("leader-lost");
    },
  };
}

const prismaStub: any = {};
const redisStub: any = { client: { set: async () => {}, publish: async () => {} } };
const noopCache: any = { getPublicState: () => null, currentMultiplier: () => 1.0 };

// Lazily import the engine AFTER env is in place is unnecessary (the engine reads the windows at
// USE time, not module load), so a normal top import is fine.
import { GameEngineService } from "../../src/game/game-engine.service";

function makeEngine(leader: boolean) {
  const metrics = makeMetrics();
  const election = makeElection(leader);
  const engine = new GameEngineService(
    prismaStub,
    redisStub,
    {} as any, // fairness — unused on these paths
    {} as any, // wallet — unused
    metrics,
    election as any,
    noopCache,
  );
  return { engine, metrics, election };
}

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  process.env[k] = v;
}
beforeEach(() => {
  // tiny windows so the test is fast + deterministic; read at use time by the engine.
  setEnv("ENGINE_PHASE_DEADLINE_MS", "150");
  setEnv("ENGINE_DEADMAN_MS", "100");
  setEnv("ENGINE_DEADMAN_CHECK_MS", "50");
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

describe("F-048/F-049 engine-stall resilience", () => {
  // ── 1. HUNG-TRANSITION → reschedule + stall metric (the headline F-048/F-076 ask) ─────────
  test("a phase that NEVER settles rejects on the per-phase deadline → records phase_transition + reschedules enterWaiting (self-heal)", async () => {
    const { engine, metrics } = makeEngine(true);
    (engine as any).running = true;

    // Inject a HUNG phase: enterBetting() returns a promise that never settles (the live
    // incident — a wedged await with no crash/no error). Stub enterWaiting() so the recovery
    // reschedule is observable WITHOUT touching the DB, and capture that it ran.
    let neverResolved = false;
    (engine as any).enterBetting = () =>
      new Promise<void>(() => {
        neverResolved = true; /* intentionally never resolve */
      });
    let recovered = 0;
    (engine as any).enterWaiting = async () => {
      recovered++;
    };

    // Drive ONE phase through safe() exactly as the loop does.
    (engine as any).safe(() => (engine as any).enterBetting(), "betting");
    expect(neverResolved).toBe(true); // the hung fn did start (and is still pending)

    // Within ~deadline (150ms) + the 1500ms back-off reschedule, the loop must self-heal:
    // safe() rejects on the deadline → catch records the metric → schedule(1500, enterWaiting).
    // Wait a touch over deadline and assert the metric fired immediately (before the back-off).
    await new Promise((r) => setTimeout(r, 250));
    expect(metrics.errors).toContain("phase_transition"); // F-049: observable, ErrorSpike can fire

    // Now wait out the 1500ms back-off and assert enterWaiting was rescheduled + ran (F-048a).
    await new Promise((r) => setTimeout(r, 1500));
    expect(recovered).toBeGreaterThanOrEqual(1); // the loop recovered itself — no human/restart

    (engine as any).stop();
  });

  // ── 2. a phase that simply THROWS is also caught + observable (F-049 regression) ──────────
  test("a phase that throws records phase_transition + reschedules (no silent error)", async () => {
    const { engine, metrics } = makeEngine(true);
    (engine as any).running = true;
    (engine as any).enterBetting = async () => {
      throw new Error("boom");
    };
    let recovered = 0;
    (engine as any).enterWaiting = async () => {
      recovered++;
    };

    (engine as any).safe(() => (engine as any).enterBetting(), "betting");
    await new Promise((r) => setTimeout(r, 50)); // throws synchronously-ish → caught fast
    expect(metrics.errors).toContain("phase_transition");

    await new Promise((r) => setTimeout(r, 1550));
    expect(recovered).toBeGreaterThanOrEqual(1);
    (engine as any).stop();
  });

  // ── 3. DEADMAN: a LEADER with a stale last-round self-demotes via election.stepDown ───────
  test("leader + lastRoundAt older than the deadman window → records engine_stall + steps down (clean lock-release for failover)", async () => {
    const { engine, metrics, election } = makeEngine(true);
    (engine as any).running = true;
    // No round has completed for well over the (tiny) deadman window.
    (engine as any).lastRoundAt = Date.now() - 10_000;

    await (engine as any).deadmanCheck();

    expect(metrics.errors).toContain("engine_stall"); // F-048c: the stall is recorded + Sentry'd
    expect(election.state.stepDowns).toBe(1); // voluntarily relinquished leadership
    expect(election.state.lastReason).toBe("engine-stall-deadman");
    expect(election.state.leader).toBe(false); // demoted → a follower can now acquire + resume

    (engine as any).stop();
  });

  // ── 4. DEADMAN no-ops on a follower (no false step-down) ──────────────────────────────────
  test("a FOLLOWER (not leader) never trips the deadman even with a stale lastRoundAt", async () => {
    const { engine, metrics, election } = makeEngine(false); // not leader
    (engine as any).running = true;
    (engine as any).lastRoundAt = Date.now() - 10_000; // very stale

    await (engine as any).deadmanCheck();

    expect(metrics.errors).not.toContain("engine_stall"); // a follower owns no loop to stall
    expect(election.state.stepDowns).toBe(0);
  });

  // ── 5. DEADMAN is single-shot per stall (re-entrancy guard) ───────────────────────────────
  test("the deadman fires step-down ONCE per stall (re-entrancy guarded)", async () => {
    const { engine, election } = makeEngine(true);
    (engine as any).running = true;
    (engine as any).lastRoundAt = Date.now() - 10_000;

    await (engine as any).deadmanCheck();
    // stepDown flipped leader=false; even if we force it back, steppingDown stays latched.
    election.state.leader = true;
    await (engine as any).deadmanCheck();

    expect(election.state.stepDowns).toBe(1); // not 2 — guarded
  });

  // ── 6. a healthy leader (fresh round) does NOT trip the deadman ───────────────────────────
  test("a leader whose round just completed does NOT step down", async () => {
    const { engine, metrics, election } = makeEngine(true);
    (engine as any).running = true;
    (engine as any).lastRoundAt = Date.now(); // a round just completed

    await (engine as any).deadmanCheck();

    expect(metrics.errors).not.toContain("engine_stall");
    expect(election.state.stepDowns).toBe(0);
  });
});
