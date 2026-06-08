import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../src/prisma/prisma.service";
import { LedgerService } from "../../src/wallet/ledger.service";
import { RiskService } from "../../src/game/risk.service";
import { MetricsService } from "../../src/metrics/metrics.service";
import { BetsService, type Panel } from "../../src/game/bets.service";
import { GameEngineService } from "../../src/game/game-engine.service";
import { makeAudit } from "../helpers/audit";

/**
 * H5 fast-follow regression suite (F-079 + F-080). Same direct-instantiation harness as
 * test/ha/failover-resume.test.ts: real Prisma + the internal LedgerService as the
 * WalletProvider, a capturing redis stub, a stubbed fairness, and a leader-election stub.
 *
 * F-079 (money — OUTCOME-AWARE stale-extra close): resumeOrRecover resumes the NEWEST open
 * round and closes any OLDER open round (a "stale extra"). Closing must mirror resumeRound's
 * pre/post-outcome distinction:
 *   - post-outcome extra (running/crashed/settling): a stranded `active` LOSER must end BUSTED
 *     (debit kept, NOT refunded — the GGR-leak fix), and an already-`cashed_out` winner stays
 *     paid EXACTLY ONCE (never refunded, never double-paid).
 *   - pre-outcome extra (betting/waiting): a live bet is REFUNDED (cancelled) as before.
 *
 * F-080 (fairness — zombie-state defense-in-depth): a late-resolving enterCrashed (this.state
 * already advanced to a FRESH round) must reveal/update the ORIGINAL round's ids, not the
 * successor's — proven by capturing the round1 identifiers into locals at entry.
 *
 * Cleanup is FK-safe + child-first (the H4 RESTRICT FKs are in effect): bets → rounds → users
 * (cascade wallets + ledger) → seeds → chains. We quiesce stray OPEN rounds before each test so
 * a real/dev open round can't get swept into our candidate/stale set.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();

type Captured = { set: string[]; publish: string[] };
function makeRedis(captured: Captured): any {
  return {
    client: {
      set: async (_k: string, v: string) => { captured.set.push(v); },
      publish: async (_c: string, v: string) => { captured.publish.push(v); },
    },
  };
}

// fairness stub: records every reveal so we can assert idempotency + which round revealed.
// `gate` (optional) lets a test BLOCK revealSeed mid-flight to drive the F-080 zombie race.
function makeFairness(reveals: string[], gate?: () => Promise<void>): any {
  return {
    ensureChain: async () => ({}),
    revealSeed: async (seedId: string) => {
      if (gate) await gate();
      reveals.push(seedId);
    },
    maintain: async () => {},
  };
}

function makeElection(): any {
  return { events: new EventEmitter(), isLeader: () => true, assertStillLeader: async () => true };
}

const noopCache: any = { getPublicState: () => null, currentMultiplier: () => 1.0 };

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];

// Synthetic-epoch allocator (see failover-resume.test.ts for the why). DISTINCT per-suite band so
// this suite's chains can NEVER collide with a sibling's in the shared process; + a per-process
// random offset + a strictly monotonic counter so no insert ever repeats (avoids the P2002 epoch
// collision that surfaced as a cross-suite flake).
const EPOCH_BASE = 920_000_000 + Math.floor(Math.random() * 10_000_000); // se suite band (distinct from fr)
let epochSeq = 0;
const nextEpoch = () => EPOCH_BASE + epochSeq++;

async function makeSeed(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: nextEpoch(),
      commitHash: "se-" + randomUUID(),
      length: 2,
      salt: "se-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "se-" + randomUUID(), seed: "se-seed-" + randomUUID() },
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

async function makeWallet(originalBalance: bigint): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "se_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance: originalBalance } },
      profile: { create: { displayName: "se" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

async function makeBet(
  roundId: string,
  w: { userId: string; walletId: string },
  panel: Panel,
  amount: bigint,
  status: string,
  extra?: { payout?: bigint; cashoutMult?: number },
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
      status,
      currency: "DEMO",
      payout: extra?.payout ?? 0n,
      cashoutMult: extra?.cashoutMult ?? null,
      settledAt: status === "active" || status === "reserving" ? null : new Date(),
    },
  });
  return betId;
}

// ── cross-suite isolation harness ──────────────────────────────────────────────────────────
// Every engine a test builds is tracked here so afterEach can QUIESCE all in-flight async work
// (a resumed climb's armed crash timer, the deadman, and the void-wrapped settle relay) BEFORE
// the next test/suite asserts. Without this, a fire-and-forget settle that out-runs a test's
// fixed setTimeout, or a leaked climbing round still OPEN in the DB, races a neighbor's
// which-round-resumed / round-STATUS assertion in the SHARED `bun test` process.
const liveEngines: GameEngineService[] = [];
const inflightSettles: Promise<unknown>[] = [];

function makeEngine(opts?: { revealGate?: () => Promise<void> }) {
  const captured: Captured = { set: [], publish: [] };
  const reveals: string[] = [];
  const election = makeElection();
  const engine = new GameEngineService(
    prisma,
    makeRedis(captured),
    makeFairness(reveals, opts?.revealGate),
    ledger,
    metrics,
    election,
    noopCache,
  );
  (engine as any).running = true;
  liveEngines.push(engine);
  return { engine, captured, reveals, election };
}

/** Wire the real settle relay exactly like gateway.afterInit so a stale-extra settle actually
 *  busts via bets.settleRound. The settle stays fire-and-forget (production-faithful), but we
 *  ALSO keep a handle to each in-flight settle so afterEach can AWAIT it — so a settle can never
 *  complete a `bet.updateMany` after the test under it has finished and leak into the next test.
 *  Returns the BetsService for assertions. */
function wireSettle(engine: GameEngineService): BetsService {
  const bets = new BetsService(prisma, ledger as any, engine, risk, metrics, makeAudit(prisma, metrics));
  engine.events.on("settle", (p: { roundId: string }) => {
    inflightSettles.push(bets.settleRound(p.roundId).catch(() => {}));
  });
  return bets;
}

const resumeOrRecover = (engine: GameEngineService): Promise<boolean> => (engine as any).resumeOrRecover();
const getState = (engine: GameEngineService): any => (engine as any).state;
const disarm = (engine: GameEngineService) => (engine as any).stop();

async function quiesceOpenRounds() {
  await prisma.round.updateMany({
    where: { status: { in: ["waiting", "betting", "running", "crashed", "settling"] } },
    data: { status: "completed" },
  });
}

/** Stop every engine this test armed, detach its settle/crash listeners (so a stray late emit
 *  from any engine can't re-fire a relay), drain in-flight settles, then close any OPEN round —
 *  so NO timer, NO listener and NO open round survives into the next test/suite. */
afterEach(async () => {
  for (const e of liveEngines.splice(0)) {
    try { (e as any).stop(); } catch { /* idempotent */ }
    try { e.events.removeAllListeners(); } catch { /* no-op */ }
  }
  // Drain any settle the relay kicked off but a test's fixed wait did not cover.
  if (inflightSettles.length) {
    await Promise.allSettled(inflightSettles.splice(0));
  }
  await quiesceOpenRounds();
});

/** A fresh, seamlessly-resumable NEWEST candidate (high crashPoint → climbs; no bets) so
 *  resumeOrRecover resumes IT and only CLOSES the older stale extra under test. */
async function makeResumableCandidate(): Promise<string> {
  return makeRound({
    status: "running",
    crashPoint: 50.0, // crash far in the future → seamless climb, no honor-pay, no settle
    startedAt: new Date(Date.now() - 200),
    phaseEndsAt: new Date(Date.now() + 60_000),
    createdAt: new Date(Date.now() - 100), // NEWER than the stale extra
  });
}

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
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

describe("F-079 outcome-aware stale-extra recovery", () => {
  // ── post-outcome (settling): stranded loser BUSTED (not refunded), paid winner stays paid once
  test("settling stale extra: stranded active LOSER → busted (debit kept), already-cashed_out WINNER stays paid exactly once", async () => {
    await quiesceOpenRounds();

    // OLDER stale extra in 'settling' (post-outcome). createdAt in the past so it's the stale one.
    const crashPoint = 2.0;
    const staleId = await makeRound({
      status: "settling",
      crashPoint,
      startedAt: new Date(Date.now() - 10_000),
      phaseEndsAt: new Date(Date.now() - 300), // its own deadline already elapsed
      crashedAt: new Date(Date.now() - 2000),
      createdAt: new Date(Date.now() - 10_000),
    });

    // A stranded LOSER: still 'active' on a post-outcome round (the dead leader never busted it).
    const wLose = await makeWallet(9000n); // already debited 1000 for the open bet
    const betLose = await makeBet(staleId, wLose, "A", 1000n, "active");

    // An already-paid WINNER: cashed_out at 1.5 for 1500 — its payout credit already landed, so
    // its wallet shows the net (9000 - debit already netted into 9000, + 1500 paid = 10500). We
    // model the post-payout balance directly and assert the recovery does NOT move it again.
    const wWin = await makeWallet(10_500n);
    const betWin = await makeBet(staleId, wWin, "A", 1000n, "cashed_out", { payout: 1500n, cashoutMult: 1.5 });

    // NEWEST candidate that resumes seamlessly (so the stale extra is the only one CLOSED).
    const candidateId = await makeResumableCandidate();

    const balLoseBefore = await ledger.getBalance(wLose.walletId);
    const balWinBefore = await ledger.getBalance(wWin.walletId);

    const { engine } = makeEngine();
    wireSettle(engine);
    const resumed = await resumeOrRecover(engine);

    // The settle relay is void-wrapped (fire-and-forget, like the gateway) — let it run.
    await new Promise((r) => setTimeout(r, 50));
    disarm(engine);

    // Resumed the NEWEST candidate, not the stale extra.
    expect(resumed).toBe(true);
    expect(getState(engine).roundId).toBe(candidateId);

    // LOSER: busted (NOT cancelled), debit kept → balance unchanged, no refund row.
    const rLose = await prisma.bet.findUniqueOrThrow({ where: { id: betLose } });
    expect(rLose.status).toBe("busted");
    expect(await ledger.getBalance(wLose.walletId)).toBe(balLoseBefore);
    expect(await prisma.ledgerTransaction.count({ where: { walletId: wLose.walletId, type: "refund" } })).toBe(0);

    // WINNER: stays cashed_out, paid EXACTLY once (recovery never refunds or double-pays it).
    const rWin = await prisma.bet.findUniqueOrThrow({ where: { id: betWin } });
    expect(rWin.status).toBe("cashed_out");
    expect(rWin.payout).toBe(1500n);
    expect(await ledger.getBalance(wWin.walletId)).toBe(balWinBefore);
    expect(await prisma.ledgerTransaction.count({ where: { walletId: wWin.walletId, type: "refund" } })).toBe(0);

    // The stale extra is closed (completed).
    expect((await prisma.round.findUniqueOrThrow({ where: { id: staleId } })).status).toBe("completed");
  });

  // ── post-outcome (crashed): stranded loser BUSTED; seed revealed + crashedAt backfilled
  test("crashed stale extra: stranded loser → busted; seed revealed (idempotent), crashedAt backfilled when null", async () => {
    await quiesceOpenRounds();
    const seedId = await makeSeed();
    const staleId = await makeRound({
      status: "crashed",
      crashPoint: 3.0,
      seedId,
      startedAt: new Date(Date.now() - 8000),
      phaseEndsAt: new Date(Date.now() - 100),
      crashedAt: null, // dead leader died before stamping → backfill expected
      createdAt: new Date(Date.now() - 8000),
    });
    const wLose = await makeWallet(9000n);
    const betLose = await makeBet(staleId, wLose, "A", 1000n, "active");
    const candidateId = await makeResumableCandidate();

    const { engine, reveals } = makeEngine();
    wireSettle(engine);
    const resumed = await resumeOrRecover(engine);
    await new Promise((r) => setTimeout(r, 50));
    disarm(engine);

    expect(resumed).toBe(true);
    expect(getState(engine).roundId).toBe(candidateId);

    // Loser busted, debit kept.
    const rLose = await prisma.bet.findUniqueOrThrow({ where: { id: betLose } });
    expect(rLose.status).toBe("busted");
    expect(await ledger.getBalance(wLose.walletId)).toBe(9000n);

    // The stale extra's seed was revealed exactly once, crashedAt backfilled, round completed.
    expect(reveals).toContain(seedId);
    expect(reveals.filter((s) => s === seedId).length).toBe(1);
    const sRound = await prisma.round.findUniqueOrThrow({ where: { id: staleId } });
    expect(sRound.crashedAt).not.toBeNull();
    expect(sRound.status).toBe("completed");
  });

  // ── pre-outcome (betting): live bet REFUNDED (unchanged behavior)
  test("betting stale extra: active bet → cancelled (refunded) as before — pre-outcome is not settled", async () => {
    await quiesceOpenRounds();
    const staleId = await makeRound({
      status: "betting",
      crashPoint: 2.0,
      phaseEndsAt: new Date(Date.now() + 1000), // not ancient — proves the REFUND is by phase, not staleness
      createdAt: new Date(Date.now() - 10_000),
    });
    const wBet = await makeWallet(9000n); // already debited 1000
    const betId = await makeBet(staleId, wBet, "A", 1000n, "active");
    const candidateId = await makeResumableCandidate();

    const { engine } = makeEngine();
    wireSettle(engine);
    const resumed = await resumeOrRecover(engine);
    await new Promise((r) => setTimeout(r, 50));
    disarm(engine);

    expect(resumed).toBe(true);
    expect(getState(engine).roundId).toBe(candidateId);

    // Pre-outcome → refunded (cancelled), balance restored, a refund row written.
    const r = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(r.status).toBe("cancelled");
    expect(await ledger.getBalance(wBet.walletId)).toBe(10_000n);
    expect(await prisma.ledgerTransaction.count({ where: { walletId: wBet.walletId, type: "refund" } })).toBe(1);
    expect((await prisma.round.findUniqueOrThrow({ where: { id: staleId } })).status).toBe("completed");
  });

  // ── pre-outcome (waiting): no bets, just closed (unchanged behavior)
  test("waiting stale extra: no result → closed completed (nothing to refund)", async () => {
    await quiesceOpenRounds();
    const staleId = await makeRound({
      status: "waiting",
      crashPoint: 2.0,
      phaseEndsAt: new Date(Date.now() + 1000),
      createdAt: new Date(Date.now() - 10_000),
    });
    const candidateId = await makeResumableCandidate();

    const { engine } = makeEngine();
    wireSettle(engine);
    const resumed = await resumeOrRecover(engine);
    await new Promise((r) => setTimeout(r, 50));
    disarm(engine);

    expect(resumed).toBe(true);
    expect(getState(engine).roundId).toBe(candidateId);
    expect((await prisma.round.findUniqueOrThrow({ where: { id: staleId } })).status).toBe("completed");
  });

  // ── idempotency: a stale-extra settle cannot double-pay/refund a winner on a second pass
  test("idempotent: closing the SAME settling stale extra twice never refunds the loser or re-pays the winner", async () => {
    await quiesceOpenRounds();
    const staleId = await makeRound({
      status: "settling",
      crashPoint: 2.0,
      startedAt: new Date(Date.now() - 10_000),
      phaseEndsAt: new Date(Date.now() - 300),
      crashedAt: new Date(Date.now() - 2000),
      createdAt: new Date(Date.now() - 10_000),
    });
    const wLose = await makeWallet(9000n);
    const betLose = await makeBet(staleId, wLose, "A", 1000n, "active");
    const wWin = await makeWallet(10_500n);
    await makeBet(staleId, wWin, "A", 1000n, "cashed_out", { payout: 1500n, cashoutMult: 1.5 });

    // Drive closeStaleExtra directly TWICE on the same (now-mutating) row image.
    const { engine } = makeEngine();
    wireSettle(engine);
    const close = (row: any): Promise<void> => (engine as any).closeStaleExtra(row);
    const row = await prisma.round.findUniqueOrThrow({ where: { id: staleId } });
    await close(row);
    await new Promise((r) => setTimeout(r, 50));
    const balLoseAfterFirst = await ledger.getBalance(wLose.walletId);
    const balWinAfterFirst = await ledger.getBalance(wWin.walletId);
    // Re-feed the ORIGINAL (settling) image — settleRound is a CAS on status=active (no active
    // bets remain → no-op), reveal is an unconditional write (idempotent), no refund key used.
    await close({ ...row, crashedAt: null });
    await new Promise((r) => setTimeout(r, 50));
    disarm(engine);

    const rLose = await prisma.bet.findUniqueOrThrow({ where: { id: betLose } });
    expect(rLose.status).toBe("busted");
    expect(await ledger.getBalance(wLose.walletId)).toBe(balLoseAfterFirst);
    expect(await ledger.getBalance(wWin.walletId)).toBe(balWinAfterFirst);
    expect(await prisma.ledgerTransaction.count({ where: { walletId: wLose.walletId, type: "refund" } })).toBe(0);
    expect(await prisma.ledgerTransaction.count({ where: { walletId: wWin.walletId, type: "refund" } })).toBe(0);
  });
});

describe("F-080 zombie-state defense-in-depth (enterCrashed captures round ids at entry)", () => {
  // A late-resolving enterCrashed must act on the ORIGINAL round's ids, not a successor's, even
  // if this.state is re-pointed at a FRESH round while enterCrashed is awaiting inside.
  test("a hung enterCrashed reveals/updates the ORIGINAL round even after this.state advances to a fresh round", async () => {
    await quiesceOpenRounds();

    // Round 1 — the one enterCrashed is invoked for; it will hang inside revealSeed.
    const seed1 = await makeSeed();
    const round1 = await makeRound({
      status: "running",
      crashPoint: 4.0,
      seedId: seed1,
      startedAt: new Date(Date.now() - 1000),
      phaseEndsAt: new Date(Date.now() + 60_000),
    });
    // Round 2 — the SUCCESSOR a recovered loop swaps this.state to mid-flight.
    const seed2 = await makeSeed();
    const round2 = await makeRound({
      status: "waiting",
      crashPoint: 9.0,
      seedId: seed2,
      phaseEndsAt: new Date(Date.now() + 60_000),
    });

    // A gate that BLOCKS revealSeed until we release it — so we can advance this.state mid-crash.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { engine, reveals } = makeEngine({ revealGate: () => gate });

    // Seed this.state with ROUND 1, exactly as resumeRound/the loop would before enterCrashed.
    (engine as any).state = {
      roundId: round1,
      seedId: seed1,
      phase: "running",
      phaseEndsAt: Date.now() + 60_000,
      startedAt: Date.now() - 1000,
      crashPoint: 4.0,
    };

    // Invoke enterCrashed for round1 — it will block awaiting revealSeed (the gate).
    const crashing = (engine as any).enterCrashed() as Promise<void>;
    await new Promise((r) => setTimeout(r, 20)); // let it reach the gate

    // ZOMBIE WINDOW: a recovered loop re-points this.state at the FRESH successor round2.
    (engine as any).state = {
      roundId: round2,
      seedId: seed2,
      phase: "running",
      phaseEndsAt: Date.now() + 60_000,
      startedAt: Date.now(),
      crashPoint: 9.0,
    };

    // Release the gate → the late enterCrashed finishes. It MUST act on round1's captured ids.
    release();
    await crashing;
    disarm(engine);

    // The reveal targeted ROUND 1's seed, NOT round2's (the successor in this.state).
    expect(reveals).toEqual([seed1]);
    expect(reveals).not.toContain(seed2);

    // The DB update flipped ROUND 1 to crashed; ROUND 2 was NOT touched (still waiting).
    expect((await prisma.round.findUniqueOrThrow({ where: { id: round1 } })).status).toBe("crashed");
    expect((await prisma.round.findUniqueOrThrow({ where: { id: round2 } })).status).toBe("waiting");
  });

  // Focused unit check: enterCrashed operates on the ids present at ENTRY (the locals), proven by
  // reading them off the synchronously-emitted 'crash' event before any state mutation can race.
  test("enterCrashed emits the 'crash' event with the entry round's id + crashPoint", async () => {
    await quiesceOpenRounds();
    const seedId = await makeSeed();
    const roundId = await makeRound({
      status: "running",
      crashPoint: 7.0,
      seedId,
      startedAt: new Date(Date.now() - 1000),
      phaseEndsAt: new Date(Date.now() + 60_000),
    });

    const { engine } = makeEngine();
    (engine as any).state = {
      roundId,
      seedId,
      phase: "running",
      phaseEndsAt: Date.now() + 60_000,
      startedAt: Date.now() - 1000,
      crashPoint: 7.0,
    };

    const crashes: { roundId: string; crashMultiplier: number }[] = [];
    engine.events.on("crash", (p: { roundId: string; crashMultiplier: number }) => crashes.push(p));

    await (engine as any).enterCrashed();
    disarm(engine);

    expect(crashes.length).toBe(1);
    expect(crashes[0].roundId).toBe(roundId);
    expect(crashes[0].crashMultiplier).toBe(7.0);
  });
});
