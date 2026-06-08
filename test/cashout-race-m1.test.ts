import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { makeAudit } from "./helpers/audit";

/**
 * Regression for audit M1 (double cash-out inflates leaderboard / desyncs payout).
 *
 * A manual + auto cash-out race (or two sockets) on ONE active bet used to run
 * the unconditional leaderboard UPDATE and bet.update TWICE: money was paid once
 * (the payout idempotency key `bet:{id}:payout` is shared), but `profiles.total_loot`
 * was incremented twice (phantom loot) and `Bet.payout` could be left desynced.
 *
 * The fix CLAIMS the bet atomically (`updateMany WHERE id AND status='active'`)
 * and only credits + bumps the leaderboard if exactly one row was claimed; the
 * loser returns `no_active_bet`. We assert: exactly ONE payout_credit, the
 * leaderboard `total_loot` increased by exactly the payout (once), and `Bet.payout`
 * equals the credited amount.
 *
 * Pre-fix, `total_loot` would equal 2*payout — this test would FAIL on that line.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();

// Fake engine pinned to the running phase at a fixed multiplier.
let activeRoundId = "";
const RUNNING_MULT = 2.0;
const fakeEngine: any = {
  getPublicState: () => ({
    roundId: activeRoundId,
    phase: "running",
    phaseEndsAt: Date.now() + 60_000,
    multiplier: RUNNING_MULT,
    serverTime: Date.now(),
  }),
  currentMultiplier: () => RUNNING_MULT,
};

const bets = new BetsService(prisma, ledger, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];

async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 3_000_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "m1commit-" + randomUUID(),
      length: 2,
      salt: "m1salt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "m1h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status: "running", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function freshUser(balance: bigint): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "m1_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "m1" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

/** Insert an already-placed active bet (debit already taken) for the round. */
async function activeBet(opts: {
  roundId: string;
  userId: string;
  walletId: string;
  panel: "A" | "B";
  amount: bigint;
  autoCashout?: number;
}): Promise<string> {
  const betId = randomUUID();
  await prisma.bet.create({
    data: {
      id: betId,
      roundId: opts.roundId,
      userId: opts.userId,
      walletId: opts.walletId,
      panel: opts.panel,
      amount: opts.amount,
      autoCashout: opts.autoCashout ?? null,
      status: "active",
    },
  });
  return betId;
}

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  try {
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

test("M1: manual + auto cash-out race credits once and increments total_loot once", async () => {
  activeRoundId = await freshRound();
  const { userId, walletId } = await freshUser(9_900n); // 100 already debited for the bet
  const stake = 100n;
  const autoTarget = 2.0;
  await activeBet({ roundId: activeRoundId, userId, walletId, panel: "A", amount: stake, autoCashout: autoTarget });

  const lootBefore = (await prisma.profile.findUniqueOrThrow({ where: { userId } })).totalLoot;
  const expectedPayout = stake * 2n; // stake * 2.0x, under the win cap

  // Manual cash-out (live multiplier) races the server auto-cashout (at target).
  const [manual, autoResults] = await Promise.all([
    bets.cashOut(userId, "A"),
    bets.evaluateAutoCashouts(autoTarget),
  ]);

  // Exactly one of the two paths actually settled the bet.
  const autoOk = autoResults.length === 1;
  const settledCount = (manual.ok ? 1 : 0) + (autoOk ? 1 : 0);
  expect(settledCount).toBe(1);

  // Exactly ONE payout_credit on the wallet, equal to the expected payout.
  const credits = await prisma.ledgerTransaction.findMany({ where: { walletId, type: "payout_credit" } });
  expect(credits.length).toBe(1);
  expect(credits[0].amount).toBe(expectedPayout);

  // Leaderboard total_loot bumped by exactly the payout — ONCE (no phantom loot).
  const lootAfter = (await prisma.profile.findUniqueOrThrow({ where: { userId } })).totalLoot;
  expect(lootAfter - lootBefore).toBe(expectedPayout);

  // Bet.payout matches the credited amount, status cashed_out.
  const bet = await prisma.bet.findFirstOrThrow({ where: { roundId: activeRoundId, userId, panel: "A" } });
  expect(bet.status).toBe("cashed_out");
  expect(bet.payout).toBe(expectedPayout);
  expect(bet.payout).toBe(credits[0].amount);

  // Balance reflects exactly one credit: 9900 (post-debit) + payout.
  expect(await ledger.getBalance(walletId)).toBe(9_900n + expectedPayout);
});

test("M1: two concurrent manual cash-outs settle once (high contention)", async () => {
  activeRoundId = await freshRound();
  const { userId, walletId } = await freshUser(9_800n);
  const stake = 200n;
  await activeBet({ roundId: activeRoundId, userId, walletId, panel: "B", amount: stake });

  const lootBefore = (await prisma.profile.findUniqueOrThrow({ where: { userId } })).totalLoot;
  const expectedPayout = stake * 2n; // RUNNING_MULT = 2.0x

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => bets.cashOut(userId, "B")),
  );
  expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  const oks = results.filter((r) => r.status === "fulfilled" && (r.value as any).ok);
  const losers = results.filter((r) => r.status === "fulfilled" && !(r.value as any).ok);
  expect(oks.length).toBe(1);
  // Every loser is cleanly told the bet is no longer claimable.
  expect(losers.every((r) => (r.value as any).reason === "no_active_bet")).toBe(true);

  const credits = await prisma.ledgerTransaction.findMany({ where: { walletId, type: "payout_credit" } });
  expect(credits.length).toBe(1);
  expect(credits[0].amount).toBe(expectedPayout);

  const lootAfter = (await prisma.profile.findUniqueOrThrow({ where: { userId } })).totalLoot;
  expect(lootAfter - lootBefore).toBe(expectedPayout);
  expect(await ledger.getBalance(walletId)).toBe(9_800n + expectedPayout);
});
