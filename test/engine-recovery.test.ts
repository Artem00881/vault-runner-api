import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { GameEngineService } from "../src/game/game-engine.service";

// We test recoverInterruptedRounds in isolation: construct the engine with real
// Prisma + the internal ledger as the wallet provider, leave fairness/redis as
// stubs (recovery doesn't use them), and drive the private method directly.
const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const redisStub: any = { client: { set: async () => {} } };
const fairnessStub: any = {};
// Phase 4.5b: +ElectionService +PublicRoundCache args. recover* never reads them, so
// stubs suffice; this just keeps the constructor arity correct (single-node behavior).
const engine = new GameEngineService(prisma, redisStub, fairnessStub, ledger, {} as any, {} as any, {} as any);
const recover = () => (engine as any).recoverInterruptedRounds();

// Track everything we create so afterAll can purge it — otherwise these
// synthetic rounds (closed with a null salt, never revealed) accumulate in the
// shared dev DB and break engine-fairness, which scans real persisted rounds.
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdUserIds: string[] = [];
const createdChainIds: string[] = [];

// Synthetic-epoch allocator: a distinct high band + per-process random offset + strictly
// monotonic counter so @@unique(epoch) can't P2002-collide across the shared `bun test` process
// (a plain `1e6 + random(1e6)` collided with leftover/sibling rows — a cross-suite flake).
const EPOCH_BASE = 1_000_000_000 + Math.floor(Math.random() * 10_000_000);
let epochSeq = 0;
const nextEpoch = () => EPOCH_BASE + epochSeq++;

async function seedRound() {
  // a fairness chain + seed + round are needed for the FKs
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: nextEpoch(), // synthetic, collision-proof, avoids real epochs
      commitHash: "c" + randomUUID(),
      length: 2,
      salt: "s" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "h" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: {
      seedId: seed.id,
      nonce: 1n,
      crashPoint: 2.0,
      status: "running", // a round interrupted mid-flight
      bettingOpensAt: new Date(),
    },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function fundedWallet(balance: bigint): Promise<string> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "rec_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "rec" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return u.wallets[0].id;
}

beforeAll(async () => { await prisma.$connect(); });
// recoverInterruptedRounds() is fully awaited and arms no timers, but close any OPEN round at
// the end of each test so a synthetic `running` round can never survive into a later suite's
// resumeOrRecover/open-round scan in the SHARED `bun test` process.
afterEach(async () => {
  await prisma.round.updateMany({
    where: { status: { in: ["waiting", "betting", "running", "crashed", "settling"] } },
    data: { status: "completed" },
  });
});
afterAll(async () => {
  // Best-effort cleanup of this run's synthetic rows (FK-safe order:
  // rounds cascade their bets; users cascade their wallets + ledger txns;
  // fairness seeds are deletable once no round references them).
  try {
    if (createdRoundIds.length)
      await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length)
      await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length)
      await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    if (createdUserIds.length)
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

test("recovery refunds active bets of an interrupted round and closes it", async () => {
  const roundId = await seedRound();
  const walletId = await fundedWallet(9900n); // already debited 100 for the bet
  const userId = (await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } })).userId;
  const betId = randomUUID();
  await prisma.bet.create({
    data: { id: betId, roundId, userId, walletId, panel: "A", amount: 100n, status: "active" },
  });

  await recover();

  // bet refunded → balance back to 10000, bet cancelled, round completed
  expect(await ledger.getBalance(walletId)).toBe(10000n);
  expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("cancelled");
  expect((await prisma.round.findUniqueOrThrow({ where: { id: roundId } })).status).toBe("completed");
});

test("recovery is idempotent — a second run does not double-refund", async () => {
  const roundId = await seedRound();
  const walletId = await fundedWallet(9800n);
  const userId = (await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } })).userId;
  const betId = randomUUID();
  await prisma.bet.create({
    data: { id: betId, roundId, userId, walletId, panel: "A", amount: 200n, status: "active" },
  });

  await recover();
  const afterFirst = await ledger.getBalance(walletId);
  await recover(); // run again (e.g. a crash-loop on boot)
  const afterSecond = await ledger.getBalance(walletId);

  expect(afterFirst).toBe(10000n);
  expect(afterSecond).toBe(10000n); // not 10200 — the refund key is idempotent
});

test("recovery with no interrupted rounds is a no-op", async () => {
  // mark any leftover open rounds done first, then a clean run shouldn't throw
  await prisma.round.updateMany({
    where: { status: { in: ["waiting", "betting", "running", "crashed", "settling"] } },
    data: { status: "completed" },
  });
  await recover(); // should simply return
  expect(true).toBe(true);
});
