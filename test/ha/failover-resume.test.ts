import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../src/prisma/prisma.service";
import { LedgerService } from "../../src/wallet/ledger.service";
import { RiskService } from "../../src/game/risk.service";
import { MetricsService } from "../../src/metrics/metrics.service";
import { BetsService, type Panel } from "../../src/game/bets.service";
import { GameEngineService, GROWTH } from "../../src/game/game-engine.service";
import { makeAudit } from "../helpers/audit";

/**
 * Phase 4.5c.2 — SEAMLESS FAILOVER-RESUME regression suite (the phase's headline behavior,
 * previously with ZERO direct coverage). Direct-instantiation style (like
 * test/engine-recovery.test.ts + test/ha/engine-leadership.test.ts): real Prisma + the
 * internal ledger as the WalletProvider, a CAPTURING redis stub (so we can assert the
 * published snapshot is crashPoint-FREE), a stubbed fairness (revealSeed/ensureChain only),
 * and a leader election stub. We drive resumeOrRecover()/resumeRound() directly and assert
 * the resume invariants:
 *   - running+live  → seamless climb (crash re-armed at startedAt+log(crashPoint)/GROWTH,
 *                     state rebuilt WITH crashPoint, snapshot crashPoint-FREE, no money moved);
 *   - running+past  → honor-then-crash (target<crashPoint paid at target, the rest BUST);
 *   - settling      → settleRound runs (H-1: losing bets BUSTED, not stranded active);
 *   - crashed       → seed revealed (idempotent), crashedAt backfilled, bets busted;
 *   - crashPoint==1 → all BUST, NOT refunded (M-1);
 *   - staleness     → ancient waiting/betting close+refund; fresh resumes;
 *   - multi-open    → newest resumed, older close+refunded;
 *   - corrupt       → close+refund + fresh start;
 *   - clean DB      → resumeOrRecover()==false (single-node path unchanged);
 *   - idempotency   → double-resume never double-pays/refunds/reveals.
 *
 * Cleanup is tracked + FK-safe (rounds→bets, then users→wallets/ledger, then seeds, chains
 * last) so we never leave synthetic rows behind to poison engine-fairness (the documented
 * DB-pollution lesson). We also clear ALL pre-existing OPEN rounds before each resume test so
 * a stray real/dev open round can't get swept into our resume candidate set.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();

// ---- capturing redis stub: records every snapshot the engine publishes (mirror()) so we
//      can prove crashPoint never leaks into the public state.
type Captured = { set: string[]; publish: string[] };
function makeRedis(captured: Captured): any {
  return {
    client: {
      set: async (_k: string, v: string) => { captured.set.push(v); },
      publish: async (_c: string, v: string) => { captured.publish.push(v); },
    },
  };
}

// ---- fairness stub: resume only ever touches revealSeed (idempotent revealedAt write) and
//      ensureChain (start() preamble). Record reveals so we can assert idempotency.
function makeFairness(reveals: string[]): any {
  return {
    ensureChain: async () => ({}),
    revealSeed: async (seedId: string) => { reveals.push(seedId); },
    maintain: async () => {},
  };
}

// ---- leader election stub: we have just won the lock, so we are the authoritative leader.
function makeElection(): any {
  return {
    events: new EventEmitter(),
    isLeader: () => true,
    assertStillLeader: async () => true,
  };
}

const noopCache: any = { getPublicState: () => null, currentMultiplier: () => 1.0 };

// ---- cleanup tracking (FK-safe) ----
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];

// Synthetic-epoch allocator. `epoch` is @@unique, and the HA suites run in ONE shared `bun test`
// process — a plain `9e6 + random(1e6)` collides across suites/reps (birthday paradox over many
// chain inserts, or against a prior run's not-yet-purged rows), throwing P2002 mid-makeSeed (a
// cross-suite isolation flake). Make it collision-proof: a per-suite base band (distinct from the
// other HA suites) + a per-process random offset (dodges leftover rows from a prior run) + a
// STRICTLY MONOTONIC counter (no two inserts in this process ever repeat). Still > real/dev epochs.
const EPOCH_BASE = 900_000_000 + Math.floor(Math.random() * 10_000_000); // fr suite band
let epochSeq = 0;
const nextEpoch = () => EPOCH_BASE + epochSeq++;

/** A fresh fairness chain + a single usable seed (chainIndex 1). Synthetic epoch so it never
 *  collides with real/dev epochs OR a sibling suite; status 'exhausted' so fairness scans skip it. */
async function makeSeed(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: nextEpoch(),
      commitHash: "fr-" + randomUUID(),
      length: 2,
      salt: "fr-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "fr-" + randomUUID(), seed: "fr-seed-" + randomUUID() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  return seed.id;
}

interface RoundOpts {
  status: string;
  crashPoint: number;
  startedAt?: Date | null;
  phaseEndsAt?: Date | null;
  crashedAt?: Date | null;
  seedId?: string;
  createdAt?: Date;
}

/** Persist a round in an arbitrary phase with arbitrary timestamps — exactly the kind of
 *  zombie a dead leader leaves behind for the survivor to resume. (seedId is NOT NULL in the
 *  schema, so a "missing seedId" can't actually be persisted — that guard is validated at the
 *  unresumableReason() level instead, in scenario 8.) */
async function makeRound(o: RoundOpts): Promise<string> {
  const round = await prisma.round.create({
    data: {
      seedId: o.seedId ?? (await makeSeed()),
      nonce: 1n,
      crashPoint: o.crashPoint,
      status: o.status,
      bettingOpensAt: new Date(),
      startedAt: o.startedAt ?? null,
      phaseEndsAt: o.phaseEndsAt === undefined ? new Date(Date.now() + 60_000) : o.phaseEndsAt,
      crashedAt: o.crashedAt ?? null,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    },
  });
  createdRoundIds.push(round.id);
  return round.id;
}

/** A funded DEMO wallet (already debited by `debited` for its open bet, so a refund lands it
 *  back at `original`). Returns ids the bet + assertions need. */
async function makeWallet(originalBalance: bigint): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "fr_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance: originalBalance } },
      profile: { create: { displayName: "fr" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

/** Insert an ACTIVE bet (already debited) directly — the dead leader's open bet. */
async function makeActiveBet(
  roundId: string,
  w: { userId: string; walletId: string },
  panel: Panel,
  amount: bigint,
  autoCashout?: number,
): Promise<string> {
  const betId = randomUUID();
  await prisma.bet.create({
    data: {
      id: betId,
      roundId,
      userId: w.userId,
      walletId: w.walletId,
      panel,
      amount,
      autoCashout: autoCashout ?? null,
      status: "active",
      currency: "DEMO",
    },
  });
  return betId;
}

// ── cross-suite isolation harness ──────────────────────────────────────────────────────────
// Every engine a test builds is tracked here so afterEach can QUIESCE all in-flight async work
// (a SEAMLESS-CLIMB round's armed crash timer that stays running 60s, the deadman, and the
// void-wrapped settle relay) BEFORE the next test/suite asserts. A resumed climb left running in
// the DB, or a settle that out-runs a test's fixed setTimeout, would otherwise be transiently
// visible to a neighbor's resumeOrRecover / round-STATUS assertion in the SHARED `bun test`
// process (the diagnosed which-round-resumed flake).
const liveEngines: GameEngineService[] = [];
const inflightSettles: Promise<unknown>[] = [];

/** Build a freshly-wired engine for ONE test: fresh redis-capture + reveal log + election. */
function makeEngine() {
  const captured: Captured = { set: [], publish: [] };
  const reveals: string[] = [];
  const election = makeElection();
  const engine = new GameEngineService(
    prisma,
    makeRedis(captured),
    makeFairness(reveals),
    ledger,
    metrics,
    election,
    noopCache,
  );
  (engine as any).running = true; // we're "started" (leader acquired) so schedule() arms timers
  liveEngines.push(engine);
  return { engine, captured, reveals, election };
}

/** Wire the real money drivers exactly like gateway.afterInit: the awaitable auto-cashout
 *  driver (honor-then-crash) + the settle relay (settling/crash → settleRound). The settle stays
 *  fire-and-forget (production-faithful), but we ALSO keep a handle to each in-flight settle so
 *  afterEach can AWAIT it — so a settle's `bet.updateMany` can never land after the test under it
 *  has finished and leak into the next. Returns the BetsService so a test can assert via it. */
function wireMoneyDrivers(engine: GameEngineService): BetsService {
  const bets = new BetsService(prisma, ledger as any, engine, risk, metrics, makeAudit(prisma, metrics));
  engine.setAutoCashoutDriver((m) => bets.evaluateAutoCashouts(m));
  engine.events.on("settle", (p: { roundId: string }) => {
    inflightSettles.push(bets.settleRound(p.roundId).catch(() => {}));
  });
  return bets;
}

const resumeOrRecover = (engine: GameEngineService): Promise<boolean> => (engine as any).resumeOrRecover();
const resumeRound = (engine: GameEngineService, r: any): Promise<void> => (engine as any).resumeRound(r);
const getState = (engine: GameEngineService): any => (engine as any).state;

/** No engine instance leaves a live setTimeout behind to fire into the next test. */
function disarm(engine: GameEngineService) {
  (engine as any).stop();
}

/** Parse every captured snapshot payload (set + publish) into objects. */
function snapshots(captured: Captured): any[] {
  return [...captured.set, ...captured.publish].map((s) => JSON.parse(s));
}

/** Clear any pre-existing OPEN round so our resume-candidate set is exactly what the test
 *  created (a stray dev/real open round must not get swept into the candidate or stale list). */
async function quiesceOpenRounds() {
  await prisma.round.updateMany({
    where: { status: { in: ["waiting", "betting", "running", "crashed", "settling"] } },
    data: { status: "completed" },
  });
}

/** Stop every engine this test armed (cancels its armed crash/deadman timers), detach its
 *  settle listeners (so a stray late emit can't re-fire a relay), drain in-flight settles, then
 *  close any OPEN round — so NO timer, NO listener and NO resumed-climb open round survives into
 *  the next test/suite. Several scenarios deliberately leave the DB round OPEN (the seamless
 *  climb / newest-resumed) and rely only on stop() to cancel the timer; this is the belt that
 *  also closes the round so a leaked neighbor can't be mistaken for a resume candidate. */
afterEach(async () => {
  for (const e of liveEngines.splice(0)) {
    try { (e as any).stop(); } catch { /* idempotent */ }
    try { e.events.removeAllListeners(); } catch { /* no-op */ }
  }
  if (inflightSettles.length) {
    await Promise.allSettled(inflightSettles.splice(0));
  }
  await quiesceOpenRounds();
});

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe purge of THIS run's synthetic rows: bets (children of rounds) → rounds → users
  // (cascade wallets + ledger txns) → seeds → chains. Best-effort; never fail the suite on it.
  try {
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

describe("Phase 4.5c.2 seamless failover-resume", () => {
  // ── Scenario 1 ───────────────────────────────────────────────────────────────────────
  test("running + now < crashTime → seamless climb (crash re-armed at the deterministic time, state holds crashPoint, no money moved, snapshot crashPoint-FREE)", async () => {
    await quiesceOpenRounds();
    const crashPoint = 50.0; // high → crash time well in the future
    // started 200ms ago: crash at startedAt + log(50)/GROWTH ≈ +32.6s, comfortably ahead of now.
    const startedAt = new Date(Date.now() - 200);
    const roundId = await makeRound({ status: "running", crashPoint, startedAt, phaseEndsAt: new Date(Date.now() + 60_000) });
    const w = await makeWallet(9000n); // already debited 1000 for the open bet
    await makeActiveBet(roundId, w, "A", 1000n);
    const balBefore = await ledger.getBalance(w.walletId);

    const { engine, captured } = makeEngine();
    const resumed = await resumeOrRecover(engine);
    expect(resumed).toBe(true);

    // state rebuilt WITH the (server-only) crashPoint, phase still running.
    const st = getState(engine);
    expect(st.roundId).toBe(roundId);
    expect(st.phase).toBe("running");
    expect(st.crashPoint).toBe(crashPoint);

    // a crash timer is armed (the climb continues) and the DB round is still running.
    expect((engine as any).timer).not.toBeNull();
    expect((await prisma.round.findUniqueOrThrow({ where: { id: roundId } })).status).toBe("running");

    // the resume itself moved NO money: balance + bet status unchanged.
    expect(await ledger.getBalance(w.walletId)).toBe(balBefore);
    const bet = await prisma.bet.findFirstOrThrow({ where: { roundId } });
    expect(bet.status).toBe("active");

    // every published/snapshotted state is crashPoint-FREE, and getPublicState() too.
    const pub = engine.getPublicState()!;
    expect("crashPoint" in (pub as any)).toBe(false);
    const snaps = snapshots(captured);
    expect(snaps.length).toBeGreaterThan(0);
    for (const s of snaps) {
      expect("crashPoint" in s).toBe(false);
      expect(s.roundId).toBe(roundId);
    }

    disarm(engine); // cancel the armed crash so it can't fire into later tests
  });

  // ── Scenario 2 ───────────────────────────────────────────────────────────────────────
  test("running + now >= crashTime → honor-then-crash (target<crashPoint paid at TARGET, target>=crashPoint BUSTED, no over-crash pay, no double pay, crashed→settled)", async () => {
    await quiesceOpenRounds();
    const crashPoint = 3.0;
    // crash time is ~2s in the PAST → the survivor must honor the due autos then crash.
    const crashAgoMs = 2000;
    const startedAt = new Date(Date.now() - (Math.log(crashPoint) / GROWTH) - crashAgoMs);
    const roundId = await makeRound({ status: "running", crashPoint, startedAt, phaseEndsAt: new Date(Date.now() + 60_000) });

    // Three bets, all stake 1000, distinct users/panels:
    //   WIN:  target 2.0  (< 3.0)  → paid at 2.0  → payout 2000
    //   BUST: target 3.0  (==3.0)  → mult>=crash  → busted (debit kept)
    //   BUST: target 5.0  (> 3.0)  → never reached → busted by settleRound
    const wWin = await makeWallet(9000n);
    const wEq = await makeWallet(9000n);
    const wHigh = await makeWallet(9000n);
    const betWin = await makeActiveBet(roundId, wWin, "A", 1000n, 2.0);
    const betEq = await makeActiveBet(roundId, wEq, "A", 1000n, 3.0);
    const betHigh = await makeActiveBet(roundId, wHigh, "A", 1000n, 5.0);

    const { engine } = makeEngine();
    const bets = wireMoneyDrivers(engine);

    const resumed = await resumeOrRecover(engine);
    expect(resumed).toBe(true);

    // resumeRound's running-elapsed branch already (a) honored the autos via the driver and
    // (b) ran enterCrashed → state is now 'crashed', DB round 'crashed'. Drive the rest of the
    // forward path deterministically (settle emit → settleRound; then completed) so the round
    // reaches the terminal phase, instead of waiting on the real 2.5s/0.5s timers.
    expect(getState(engine).phase).toBe("crashed");
    await (engine as any).enterSettling(); // emits "settle" → settleRound busts the remainder
    await (engine as any).enterCompleted();
    disarm(engine);

    // WIN: paid at its TARGET 2.0 → 2000, cashed_out, never above crash.
    const rWin = await prisma.bet.findUniqueOrThrow({ where: { id: betWin } });
    expect(rWin.status).toBe("cashed_out");
    expect(rWin.payout).toBe(2000n);
    expect(Number(rWin.cashoutMult)).toBe(2.0);
    expect(Number(rWin.cashoutMult)).toBeLessThan(crashPoint); // never paid at/above the crash
    expect(await ledger.getBalance(wWin.walletId)).toBe(9000n + 2000n);

    // BUST (target == crashPoint): mult>=crash gate → busted, debit kept, no payout.
    const rEq = await prisma.bet.findUniqueOrThrow({ where: { id: betEq } });
    expect(rEq.status).toBe("busted");
    expect(rEq.payout).toBe(0n);
    expect(await ledger.getBalance(wEq.walletId)).toBe(9000n);

    // BUST (target > crashPoint): never reached, busted by settleRound, debit kept.
    const rHigh = await prisma.bet.findUniqueOrThrow({ where: { id: betHigh } });
    expect(rHigh.status).toBe("busted");
    expect(rHigh.payout).toBe(0n);
    expect(await ledger.getBalance(wHigh.walletId)).toBe(9000n);

    // No double pay: exactly ONE payout_credit ledger row exists for the winner, none else.
    expect(await prisma.ledgerTransaction.count({ where: { walletId: wWin.walletId, type: "payout_credit" } })).toBe(1);
    expect(await prisma.ledgerTransaction.count({ where: { walletId: wEq.walletId, type: "payout_credit" } })).toBe(0);
    expect(await prisma.ledgerTransaction.count({ where: { walletId: wHigh.walletId, type: "payout_credit" } })).toBe(0);

    // round reached terminal completed; the winner was paid below the crash (conservation).
    expect((await prisma.round.findUniqueOrThrow({ where: { id: roundId } })).status).toBe("completed");

    // Idempotency belt: a second honor-pay over the same (now non-active) bets pays nobody.
    const paidAgain = await bets.evaluateAutoCashouts(crashPoint);
    expect(paidAgain.length).toBe(0);
  });

  // ── Scenario 3 (H-1 regression) ──────────────────────────────────────────────────────
  test("settling resume settles (H-1): losing active bets the dead leader never busted end BUSTED via the real settle emit, debit kept, no payout", async () => {
    await quiesceOpenRounds();
    const crashPoint = 2.0;
    const roundId = await makeRound({
      status: "settling",
      crashPoint,
      startedAt: new Date(Date.now() - 10_000),
      phaseEndsAt: new Date(Date.now() + 300), // settling deadline just ahead
      crashedAt: new Date(Date.now() - 2000),
    });
    const wLose = await makeWallet(9000n);
    const betLose = await makeActiveBet(roundId, wLose, "A", 1000n); // stranded loser (no auto)

    const { engine } = makeEngine();
    wireMoneyDrivers(engine); // registers the settle relay → settleRound

    const resumed = await resumeOrRecover(engine);
    expect(resumed).toBe(true);

    // The settling branch emits "settle" SYNCHRONOUSLY inside resumeRound (→ our relay calls
    // settleRound, which is awaited via the void-wrapped listener). Give the microtask a beat,
    // then assert the stranded loser is now BUSTED (this is what FAILS if the settling branch
    // is reverted to scheduling enterCompleted directly without emitting "settle").
    await new Promise((r) => setTimeout(r, 50));
    disarm(engine);

    const r = await prisma.bet.findUniqueOrThrow({ where: { id: betLose } });
    expect(r.status).toBe("busted"); // settleRound ran — NOT stranded 'active'
    expect(r.payout).toBe(0n);
    expect(await ledger.getBalance(wLose.walletId)).toBe(9000n); // debit kept, no payout
    expect(await prisma.ledgerTransaction.count({ where: { walletId: wLose.walletId, type: "payout_credit" } })).toBe(0);
  });

  // ── Scenario 4 ───────────────────────────────────────────────────────────────────────
  test("crashed resume: seed revealed (idempotent), crashedAt backfilled (null → set), active bets busted via settling, crashPoint never leaks", async () => {
    await quiesceOpenRounds();
    const crashPoint = 4.0;
    const seedId = await makeSeed();
    const roundId = await makeRound({
      status: "crashed",
      crashPoint,
      seedId,
      startedAt: new Date(Date.now() - 8000),
      phaseEndsAt: new Date(Date.now() + 300),
      crashedAt: null, // the dead leader died before stamping crashedAt (fairness-L1 backfill)
    });
    const wLose = await makeWallet(9000n);
    const betLose = await makeActiveBet(roundId, wLose, "A", 1000n);

    const { engine, captured, reveals } = makeEngine();
    wireMoneyDrivers(engine);

    const resumed = await resumeOrRecover(engine);
    expect(resumed).toBe(true);

    // crashed branch revealed the seed exactly once and backfilled crashedAt.
    expect(reveals).toEqual([seedId]);
    const round = await prisma.round.findUniqueOrThrow({ where: { id: roundId } });
    expect(round.crashedAt).not.toBeNull();

    // It scheduled enterSettling at the persisted deadline; drive it deterministically so the
    // stranded loser busts via the real settle emit, then completed.
    expect(getState(engine).phase).toBe("crashed");
    await (engine as any).enterSettling();
    await new Promise((r) => setTimeout(r, 50));
    await (engine as any).enterCompleted();
    disarm(engine);

    const r = await prisma.bet.findUniqueOrThrow({ where: { id: betLose } });
    expect(r.status).toBe("busted");
    expect(await ledger.getBalance(wLose.walletId)).toBe(9000n);

    // crashPoint never leaked in any published/snapshotted state.
    for (const s of snapshots(captured)) expect("crashPoint" in s).toBe(false);
  });

  // ── Scenario 5 (M-1 regression) ──────────────────────────────────────────────────────
  test("instant-bust crashPoint == 1.00 (M-1): ALL bets BUSTED (house keeps the stake), and NO restart_refund ledger row is written (NOT refunded)", async () => {
    await quiesceOpenRounds();
    const crashPoint = 1.0; // the deterministic instant-bust outcome — NOT corruption
    // crash time = startedAt + log(1)/GROWTH = startedAt + 0 → already elapsed.
    const startedAt = new Date(Date.now() - 1000);
    const roundId = await makeRound({ status: "running", crashPoint, startedAt, phaseEndsAt: new Date(Date.now() + 60_000) });
    const wA = await makeWallet(9000n);
    const wB = await makeWallet(8500n);
    const betA = await makeActiveBet(roundId, wA, "A", 1000n, 2.0); // even with an auto target, 1.0 busts it
    const betB = await makeActiveBet(roundId, wB, "B", 1500n);

    const { engine } = makeEngine();
    wireMoneyDrivers(engine);

    // Must NOT be rejected as unresumable (the old `!(crash > 1)` guard refunded it — M-1).
    const reason = (engine as any).unresumableReason(await prisma.round.findUniqueOrThrow({ where: { id: roundId } }));
    expect(reason).toBeNull();

    const resumed = await resumeOrRecover(engine);
    expect(resumed).toBe(true);
    expect(getState(engine).phase).toBe("crashed"); // honor-then-crash ran (0 autos due at 1.0)
    await (engine as any).enterSettling();
    await new Promise((r) => setTimeout(r, 50));
    await (engine as any).enterCompleted();
    disarm(engine);

    // BOTH bets BUSTED — the house keeps the stake.
    const rA = await prisma.bet.findUniqueOrThrow({ where: { id: betA } });
    const rB = await prisma.bet.findUniqueOrThrow({ where: { id: betB } });
    expect(rA.status).toBe("busted");
    expect(rB.status).toBe("busted");

    // NOT refunded: balances stay debited, and crucially NO restart_refund credit was written.
    expect(await ledger.getBalance(wA.walletId)).toBe(9000n);
    expect(await ledger.getBalance(wB.walletId)).toBe(8500n);
    const refundRows = await prisma.ledgerTransaction.count({
      where: { walletId: { in: [wA.walletId, wB.walletId] }, type: "refund" },
    });
    expect(refundRows).toBe(0); // close+refund (the M-1 bug) would have written these
    // round is closed via the normal settlement path (completed), not force-refunded.
    expect((await prisma.round.findUniqueOrThrow({ where: { id: roundId } })).status).toBe("completed");
  });

  // ── Scenario 6 ───────────────────────────────────────────────────────────────────────
  test("staleness bound: a betting round stale > 30s → close+refund + fresh start; within the bound → resumes; waiting same (no bets)", async () => {
    // (a) ANCIENT betting (phaseEndsAt 60s in the past) → close+refund its live bet, fresh start.
    await quiesceOpenRounds();
    const ancientId = await makeRound({ status: "betting", crashPoint: 2.0, phaseEndsAt: new Date(Date.now() - 60_000) });
    const wAnc = await makeWallet(9000n);
    const betAnc = await makeActiveBet(ancientId, wAnc, "A", 1000n);

    let { engine } = makeEngine();
    const fresh1 = await resumeOrRecover(engine);
    disarm(engine);
    expect(fresh1).toBe(false); // unresumable → start() will open fresh
    // bet refunded, round closed.
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betAnc } })).status).toBe("cancelled");
    expect(await ledger.getBalance(wAnc.walletId)).toBe(10_000n); // refunded back to original
    expect((await prisma.round.findUniqueOrThrow({ where: { id: ancientId } })).status).toBe("completed");

    // (b) FRESH betting (phaseEndsAt 1s in the future) → resumes; bet untouched.
    await quiesceOpenRounds();
    const freshId = await makeRound({ status: "betting", crashPoint: 2.0, phaseEndsAt: new Date(Date.now() + 1000) });
    const wFresh = await makeWallet(9000n);
    const betFresh = await makeActiveBet(freshId, wFresh, "A", 1000n);
    ({ engine } = makeEngine());
    const resumed = await resumeOrRecover(engine);
    disarm(engine);
    expect(resumed).toBe(true);
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betFresh } })).status).toBe("active"); // untouched
    expect(await ledger.getBalance(wFresh.walletId)).toBe(9000n); // no refund

    // (c) ANCIENT waiting (no bets) → unresumable → fresh start (nothing to refund).
    await quiesceOpenRounds();
    const waitOldId = await makeRound({ status: "waiting", crashPoint: 2.0, phaseEndsAt: new Date(Date.now() - 60_000) });
    ({ engine } = makeEngine());
    const fresh2 = await resumeOrRecover(engine);
    disarm(engine);
    expect(fresh2).toBe(false);
    expect((await prisma.round.findUniqueOrThrow({ where: { id: waitOldId } })).status).toBe("completed");

    // (d) FRESH waiting (no bets) → resumes.
    await quiesceOpenRounds();
    const waitFreshId = await makeRound({ status: "waiting", crashPoint: 2.0, phaseEndsAt: new Date(Date.now() + 1000) });
    ({ engine } = makeEngine());
    const resumedWait = await resumeOrRecover(engine);
    disarm(engine);
    expect(resumedWait).toBe(true);
    expect(getState(engine).roundId).toBe(waitFreshId);
  });

  // ── Scenario 7 ───────────────────────────────────────────────────────────────────────
  test("multiple open rounds → newest resumed, older PRE-OUTCOME one close+refunded (its active bet refunded)", async () => {
    await quiesceOpenRounds();
    // older open round (createdAt in the past) with a live bet — PRE-OUTCOME (betting, not
    // ancient) so close+refund is the correct outcome-aware close (F-079). A POST-OUTCOME stale
    // extra would instead SETTLE (bust the loser, keep paid winners) — covered directly in
    // test/ha/stale-extra-outcome-aware.test.ts. Here we keep the original "older one refunded"
    // assertion valid by making the extra a pre-outcome (no-result) round.
    const olderId = await makeRound({
      status: "betting",
      crashPoint: 30.0,
      phaseEndsAt: new Date(Date.now() + 5000), // fresh (not stale) — refund is by PHASE, not staleness
      createdAt: new Date(Date.now() - 10_000),
    });
    const wOld = await makeWallet(9000n);
    const betOld = await makeActiveBet(olderId, wOld, "A", 1000n);

    // newest open round — the one that should be resumed (high crashPoint → seamless climb).
    const newerId = await makeRound({
      status: "running",
      crashPoint: 30.0,
      startedAt: new Date(Date.now() - 200),
      phaseEndsAt: new Date(Date.now() + 60_000),
      createdAt: new Date(Date.now() - 100),
    });
    const wNew = await makeWallet(9000n);
    const betNew = await makeActiveBet(newerId, wNew, "A", 1000n);

    const { engine } = makeEngine();
    const resumed = await resumeOrRecover(engine);
    disarm(engine);

    expect(resumed).toBe(true);
    expect(getState(engine).roundId).toBe(newerId); // newest resumed

    // older round close+refunded: bet cancelled + refunded, round completed.
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betOld } })).status).toBe("cancelled");
    expect(await ledger.getBalance(wOld.walletId)).toBe(10_000n);
    expect((await prisma.round.findUniqueOrThrow({ where: { id: olderId } })).status).toBe("completed");

    // newest round + its bet untouched by the resume.
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betNew } })).status).toBe("active");
    expect(await ledger.getBalance(wNew.walletId)).toBe(9000n);
    expect((await prisma.round.findUniqueOrThrow({ where: { id: newerId } })).status).toBe("running");
  });

  // ── Scenario 8 ───────────────────────────────────────────────────────────────────────
  describe("corrupt/unresumable candidate → close+refund + fresh start", () => {
    // DB-persistable corrupt rows: each is created, then resumeOrRecover must reject it
    // (resumed===false) and close+refund its live bet.
    const dbCases: { name: string; opts: RoundOpts; expectReasonIncludes: string }[] = [
      { name: "crashPoint < 1", opts: { status: "running", crashPoint: 0.5, startedAt: new Date(Date.now() - 200) }, expectReasonIncludes: "corrupt crashPoint" },
      { name: "null phaseEndsAt", opts: { status: "betting", crashPoint: 2.0, phaseEndsAt: null }, expectReasonIncludes: "missing phaseEndsAt" },
      { name: "running with null startedAt", opts: { status: "running", crashPoint: 2.0, startedAt: null }, expectReasonIncludes: "no startedAt" },
      { name: "crashed with null startedAt", opts: { status: "crashed", crashPoint: 2.0, startedAt: null }, expectReasonIncludes: "no startedAt" },
      { name: "settling with null startedAt", opts: { status: "settling", crashPoint: 2.0, startedAt: null }, expectReasonIncludes: "no startedAt" },
    ];

    for (const c of dbCases) {
      test(c.name, async () => {
        await quiesceOpenRounds();
        const roundId = await makeRound(c.opts);
        const w = await makeWallet(9000n);
        // attach a live bet so close+refund is observable.
        const betId = await makeActiveBet(roundId, w, "A", 1000n);

        const { engine } = makeEngine();
        // the validator names the right reason
        const row = await prisma.round.findUniqueOrThrow({ where: { id: roundId } });
        expect((engine as any).unresumableReason(row)).toContain(c.expectReasonIncludes);

        const resumed = await resumeOrRecover(engine);
        disarm(engine);
        expect(resumed).toBe(false); // unresumable → start() opens fresh

        // round closed; its live bet refunded.
        expect((await prisma.round.findUniqueOrThrow({ where: { id: roundId } })).status).toBe("completed");
        expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("cancelled");
        expect(await ledger.getBalance(w.walletId)).toBe(10_000n);
      });
    }

    // Validator-only corrupt rows: the DB column constraints make these IMPOSSIBLE to persist
    // (seed_id is NOT NULL; a Decimal column can't hold NaN), so the guard is asserted directly
    // on unresumableReason() with an in-memory row image (the same shape the validator reads).
    const validatorOnlyCases: { name: string; row: any; expectReasonIncludes: string }[] = [
      {
        name: "null seedId (seed_id is NOT NULL in the schema → validator-level only)",
        row: { status: "running", seedId: null, crashPoint: 2.0 as any, startedAt: new Date(), phaseEndsAt: new Date() },
        expectReasonIncludes: "missing seedId",
      },
      {
        name: "crashPoint NaN (Decimal column can't hold NaN → validator-level only)",
        row: { status: "running", seedId: "s", crashPoint: { toString: () => "NaN", valueOf: () => NaN } as any, startedAt: new Date(), phaseEndsAt: new Date() },
        expectReasonIncludes: "corrupt crashPoint",
      },
    ];

    for (const c of validatorOnlyCases) {
      test(c.name, () => {
        const { engine } = makeEngine();
        expect((engine as any).unresumableReason(c.row)).toContain(c.expectReasonIncludes);
        disarm(engine);
      });
    }
  });

  // ── Scenario 9 ───────────────────────────────────────────────────────────────────────
  test("single-node clean restart unchanged: no open round → resumeOrRecover() returns false (start() then enterWaiting, the old path)", async () => {
    await quiesceOpenRounds();
    const { engine } = makeEngine();
    const resumed = await resumeOrRecover(engine);
    disarm(engine);
    expect(resumed).toBe(false); // nothing to resume → start() falls through to enterWaiting()
    // resumeOrRecover did NOT build engine state (enterWaiting, which we did NOT call, would).
    expect(getState(engine)).toBeNull();
  });

  // ── Scenario 10 ──────────────────────────────────────────────────────────────────────
  test("double-resume / crash-loop idempotency: resuming the SAME crashed round twice → no double-reveal, no double-bust, no double-refund", async () => {
    await quiesceOpenRounds();
    const crashPoint = 3.0;
    const seedId = await makeSeed();
    const roundId = await makeRound({
      status: "crashed",
      crashPoint,
      seedId,
      startedAt: new Date(Date.now() - 8000),
      phaseEndsAt: new Date(Date.now() + 300),
      crashedAt: null,
    });
    const wLose = await makeWallet(9000n);
    const betLose = await makeActiveBet(roundId, wLose, "A", 1000n);

    // FIRST resume + drive to settled.
    const e1 = makeEngine();
    wireMoneyDrivers(e1.engine);
    expect(await resumeRound(e1.engine, await prisma.round.findUniqueOrThrow({ where: { id: roundId } }))).toBeUndefined();
    await (e1.engine as any).enterSettling();
    await new Promise((r) => setTimeout(r, 50));
    await (e1.engine as any).enterCompleted();
    disarm(e1.engine);

    const afterFirst = await prisma.bet.findUniqueOrThrow({ where: { id: betLose } });
    expect(afterFirst.status).toBe("busted");
    expect(e1.reveals).toEqual([seedId]);
    const balAfterFirst = await ledger.getBalance(wLose.walletId);
    expect(balAfterFirst).toBe(9000n);

    // SECOND resume of the SAME round (a crash-loop on boot). The round is now 'completed' —
    // resumeOrRecover scans only OPEN phases, so it would NOT even pick it up. To prove the
    // money/reveal idempotency directly we re-drive resumeRound on the (now stale) row image:
    // revealSeed is an unconditional revealedAt write (idempotent), settleRound is a CAS on
    // status=active (no active bets remain → no-op), and no refund key is ever used here.
    const e2 = makeEngine();
    wireMoneyDrivers(e2.engine);
    // Re-feed the ORIGINAL crashed image (status 'crashed') so resumeRound takes the crashed arm
    // again — it must be a no-op for money + a single reveal.
    await resumeRound(e2.engine, {
      id: roundId,
      seedId,
      status: "crashed",
      crashPoint: crashPoint as any,
      startedAt: new Date(Date.now() - 8000),
      phaseEndsAt: new Date(Date.now() + 300),
    });
    await (e2.engine as any).enterSettling();
    await new Promise((r) => setTimeout(r, 50));
    disarm(e2.engine);

    const afterSecond = await prisma.bet.findUniqueOrThrow({ where: { id: betLose } });
    expect(afterSecond.status).toBe("busted"); // still busted (not re-opened/re-paid)
    expect(e2.reveals).toEqual([seedId]); // revealed once in THIS engine — idempotent write
    expect(await ledger.getBalance(wLose.walletId)).toBe(balAfterFirst); // NO double refund/pay
    // no payout / no refund row was ever written for this loser across both resumes.
    expect(await prisma.ledgerTransaction.count({ where: { walletId: wLose.walletId, type: "payout_credit" } })).toBe(0);
    expect(await prisma.ledgerTransaction.count({ where: { walletId: wLose.walletId, type: "refund" } })).toBe(0);
  });
});
