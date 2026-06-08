import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../src/prisma/prisma.service";
import { LedgerService } from "../../src/wallet/ledger.service";
import { GameEngineService } from "../../src/game/game-engine.service";

/**
 * Phase 4.5b — engine ↔ election WIRING (design §2, §5). Direct-instantiation style
 * (like test/engine-recovery.test.ts): real Prisma + the internal ledger as wallet,
 * stubbed redis/fairness/metrics/cache, and a controllable election stub. We assert:
 *   1. the engine starts on `leader-acquired` and stops on `leader-lost`;
 *   2. a fence-gated phase transition ABORTS (no DB write) when assertStillLeader() is
 *      false, and self-demotes;
 *   3. a P2002 on round.create (Belt A — another leader minted on this seed) → stop, and
 *      does NOT retry into safe() (no busy-loop).
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const redisStub: any = { client: { set: async () => {}, publish: async () => {} } };
const noopCache: any = { getPublicState: () => null, currentMultiplier: () => 1.0 };
// Metrics stub — the engine records leader state (F-050) on wiring + rounds/errors elsewhere.
const metricsStub: any = { setEngineLeader: () => {}, recordRound: () => {}, recordError: () => {} };

/** Controllable election: a real EventEmitter so we can fire acquire/lost, plus a
 *  flippable `leader` flag that backs both isLeader() and assertStillLeader(). */
function makeElection(initialLeader: boolean) {
  const events = new EventEmitter();
  const state = { leader: initialLeader };
  return {
    events,
    state,
    isLeader: () => state.leader,
    assertStillLeader: async () => state.leader,
    get fence() {
      return state.leader ? 1n : null;
    },
  };
}

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];

// Synthetic-epoch allocator: distinct per-suite band + per-process random offset + strictly
// monotonic counter so @@unique(epoch) can't P2002-collide across the shared-process HA suites
// (or a prior run's leftover rows).
const EPOCH_BASE = 960_000_000 + Math.floor(Math.random() * 10_000_000);
let epochSeq = 0;
const nextEpoch = () => EPOCH_BASE + epochSeq++;

async function makeChainAndSeed() {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: nextEpoch(),
      commitHash: "c" + randomUUID(),
      length: 2,
      salt: "s" + randomUUID(),
      status: "active",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "h" + randomUUID() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  return { chain, seed };
}

beforeAll(async () => {
  await prisma.$connect();
});
// The wiring tests leave a synthetic `waiting`/`betting` round behind (they assert the row
// was NOT transitioned). Close any OPEN round in afterEach so it can't be visible to a later
// suite's resumeOrRecover/open-round scan in the SHARED `bun test` process.
afterEach(async () => {
  await prisma.round.updateMany({
    where: { status: { in: ["waiting", "betting", "running", "crashed", "settling"] } },
    data: { status: "completed" },
  });
});
afterAll(async () => {
  try {
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

test("engine starts on `leader-acquired` and stops on `leader-lost`", async () => {
  const election = makeElection(false);
  const engine = new GameEngineService(prisma, redisStub, {} as any, ledger, metricsStub, election as any, noopCache);

  // Observe start/stop without touching the DB loop: replace them with trackers.
  let starts = 0;
  let stops = 0;
  (engine as any).start = async () => {
    starts++;
  };
  (engine as any).stop = () => {
    stops++;
  };

  engine.onModuleInit(); // wires the listeners; not leader yet → no immediate start
  expect(starts).toBe(0);

  election.state.leader = true;
  election.events.emit("leader-acquired", 1n);
  expect(starts).toBe(1); // acquired → start the loop

  election.state.leader = false;
  election.events.emit("leader-lost");
  expect(stops).toBe(1); // lost → stop the loop
});

test("engine started ALREADY-leader in onModuleInit (DI ordering belt)", () => {
  const election = makeElection(true); // election won the lock before the engine wired up
  const engine = new GameEngineService(prisma, redisStub, {} as any, ledger, metricsStub, election as any, noopCache);
  let starts = 0;
  (engine as any).start = async () => {
    starts++;
  };
  (engine as any).stop = () => {};
  engine.onModuleInit(); // must catch the already-acquired leadership and start
  expect(starts).toBe(1);
});

test("a fence-gated phase transition ABORTS (no DB write) when assertStillLeader() is false", async () => {
  const { seed } = await makeChainAndSeed();
  // A round sitting in 'waiting' — enterBetting() would normally flip it to 'betting'.
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "waiting", bettingOpensAt: new Date() },
  });
  createdRoundIds.push(round.id);

  const election = makeElection(true);
  const engine = new GameEngineService(prisma, redisStub, {} as any, ledger, metricsStub, election as any, noopCache);
  // Seed in-memory state as if we authored this round, then make the loop "running".
  (engine as any).state = {
    roundId: round.id,
    seedId: seed.id,
    phase: "waiting",
    phaseEndsAt: Date.now() + 3000,
    startedAt: null,
    crashPoint: 2.0,
  };
  (engine as any).running = true;

  // We are no longer the authoritative leader (a second node bumped the fence).
  election.state.leader = false;
  let stopped = false;
  const realStop = (engine as any).stop.bind(engine);
  (engine as any).stop = () => {
    stopped = true;
    realStop();
  };

  await (engine as any).enterBetting();

  // The DB row must NOT have transitioned (the fence aborted before any write), and the
  // engine self-demoted.
  const after = await prisma.round.findUniqueOrThrow({ where: { id: round.id } });
  expect(after.status).toBe("waiting"); // unchanged — no stale-leader write
  expect(stopped).toBe(true); // self-demoted
});

test("P2002 on round.create (Belt A) → stop, and does NOT retry into safe()", async () => {
  const { seed } = await makeChainAndSeed();
  // Pre-mint a round on this seed so the unique([seedId]) constraint will reject a 2nd.
  const existing = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 3.0, status: "completed", bettingOpensAt: new Date() },
  });
  createdRoundIds.push(existing.id);

  const election = makeElection(true);
  // Fairness stub: maintain() no-op, allocateSeed() hands back the ALREADY-USED seed (so
  // round.create collides), crashForSeed() deterministic.
  const fairnessStub: any = {
    maintain: async () => {},
    allocateSeed: async () => ({ id: seed.id, chainIndex: 1 }),
    crashForSeed: () => 2.0,
  };
  const engine = new GameEngineService(prisma, redisStub, fairnessStub, ledger, metricsStub, election as any, noopCache);

  let stops = 0;
  (engine as any).stop = () => {
    stops++;
    (engine as any).running = false;
    if ((engine as any).timer) clearTimeout((engine as any).timer);
  };
  let rescheduled = false;
  (engine as any).schedule = () => {
    rescheduled = true;
  };
  (engine as any).running = true;

  await (engine as any).enterWaiting();

  expect(stops).toBe(1); // treated P2002 as lost leadership → stop
  expect(rescheduled).toBe(false); // did NOT retry into safe() — no busy-loop
  // No NEW round was created on this seed (still exactly the pre-minted one).
  const count = await prisma.round.count({ where: { seedId: seed.id } });
  expect(count).toBe(1);
});
