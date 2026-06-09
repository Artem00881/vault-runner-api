import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { makeAudit } from "./helpers/audit";

/**
 * Regression for the cancelBet money-path hardening (claim-first CAS).
 *
 * cancelBet() now CLAIMS the bet atomically (`updateMany WHERE id AND status='active'`
 * → 'cancelled') BEFORE crediting the refund, mirroring cashOut's claim-first CAS.
 * Previously it credited the refund FIRST and then unconditionally update()'d the
 * status, so a cancel racing a cashOut / server auto-cashout on the SAME active bet
 * could pay BOTH a refund AND a payout — money created.
 *
 * The race is a CROSS-NODE one: a follower whose cached engine phase still reads
 * 'betting' runs cancelBet while the leader (phase 'running') runs cashOut for the
 * same bet. We model that faithfully with TWO BetsService instances over the SAME
 * Prisma/ledger but DIFFERENT engine phase views — so each operation's phase pre-check
 * passes honestly and they genuinely contend on the bet-row CAS.
 *
 * INVARIANT: exactly ONE side wins. The bet ends EITHER 'cancelled' with ONLY a
 * `refund` ledger row (no payout_credit), OR 'cashed_out' with ONLY a `payout_credit`
 * (no refund). NEVER both. We assert on the per-bet ledger rows (refId=betId) and the
 * terminal status + on the wallet balance reflecting exactly one money move.
 *
 * Pre-fix (credit-then-unconditional-update), the loser's gate doesn't stop it: BOTH a
 * refund and a payout_credit land for the bet — this test FAILS on the
 * "no coexisting refund + payout" assertion.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();

let activeRoundId = "";
const RUNNING_MULT = 2.0;

// The leader's view: phase 'running' at a fixed multiplier — cashOut proceeds and pays.
const runningEngine: any = {
  getPublicState: () => ({
    roundId: activeRoundId,
    phase: "running",
    phaseEndsAt: Date.now() + 60_000,
    multiplier: RUNNING_MULT,
    serverTime: Date.now(),
  }),
  currentMultiplier: () => RUNNING_MULT,
};

// A stale follower's CACHED view: phase still 'betting' — cancelBet proceeds and refunds.
const bettingEngine: any = {
  getPublicState: () => ({
    roundId: activeRoundId,
    phase: "betting",
    phaseEndsAt: Date.now() + 60_000,
    multiplier: 1.0,
    serverTime: Date.now(),
  }),
  currentMultiplier: () => 1.0,
};

// Same prisma + ledger; only the engine phase view differs (the cross-node divergence).
const leaderBets = new BetsService(prisma, ledger, runningEngine, risk, metrics, makeAudit(prisma, metrics));
const followerBets = new BetsService(prisma, ledger, bettingEngine, risk, metrics, makeAudit(prisma, metrics));

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];

async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 4_000_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "f081commit-" + randomUUID(),
      length: 2,
      salt: "f081salt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "f081h-" + randomUUID() },
  });
  // crashPoint well above RUNNING_MULT so cashOut's authoritative round re-read passes.
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
      username: "f081_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "f081" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

/** Insert an already-placed active bet (stake already debited) for the round. */
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
      currency: "DEMO",
    },
  });
  return betId;
}

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  try {
    // FK-safe: rounds (→ bets) → seeds → chains → users (→ wallets/ledger).
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

/**
 * Assert the money invariant on a settled bet: NEVER a coexisting refund + payout.
 * Returns which side won so the caller can sanity-check the terminal state too.
 */
async function assertExactlyOneSettlement(betId: string, walletId: string, stake: bigint, expectedPayout: bigint) {
  // Ledger rows for THIS bet (refType/refId stamped by both cancel-refund and payout).
  const rows = await prisma.ledgerTransaction.findMany({ where: { refType: "bet", refId: betId } });
  const refunds = rows.filter((r) => r.type === "refund");
  const payouts = rows.filter((r) => r.type === "payout_credit");

  // THE money invariant: a cancelled-refund and a cash-out-payout for the SAME bet can
  // NEVER coexist (that would be money created). Pre-fix this is where it FAILS.
  expect(refunds.length + payouts.length).toBe(1);

  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });

  if (refunds.length === 1) {
    // Cancel won: ONLY a refund of the stake, status cancelled, NO payout.
    expect(payouts.length).toBe(0);
    expect(refunds[0].amount).toBe(stake);
    expect(bet.status).toBe("cancelled");
    expect(bet.payout).toBe(0n);
    // Balance: starting (post-debit) + the refunded stake, exactly once.
    return "cancelled" as const;
  } else {
    // Cash-out won: ONLY a payout, status cashed_out, NO refund.
    expect(refunds.length).toBe(0);
    expect(payouts[0].amount).toBe(expectedPayout);
    expect(bet.status).toBe("cashed_out");
    expect(bet.payout).toBe(expectedPayout);
    return "cashed_out" as const;
  }
}

test("F-081: cancelBet racing a manual cashOut on one active bet settles exactly once (no refund+payout)", async () => {
  activeRoundId = await freshRound();
  const { userId, walletId } = await freshUser(9_900n); // 100 already debited for the bet
  const stake = 100n;
  const betId = await activeBet({ roundId: activeRoundId, userId, walletId, panel: "A", amount: stake });
  const expectedPayout = stake * 2n; // stake × RUNNING_MULT (2.0x), under the win cap

  // Follower (cached 'betting') cancels while the leader ('running') cashes out — SAME bet.
  const [cancelRes, cashRes] = await Promise.all([
    followerBets.cancelBet(userId, "A"),
    leaderBets.cashOut(userId, "A"),
  ]);

  // Exactly one path reported ok; the loser got a clean no_active_bet.
  const okCount = (cancelRes.ok ? 1 : 0) + (cashRes.ok ? 1 : 0);
  expect(okCount).toBe(1);
  if (!cancelRes.ok) expect(cancelRes.reason).toBe("no_active_bet");
  if (!cashRes.ok) expect(cashRes.reason).toBe("no_active_bet");

  const winner = await assertExactlyOneSettlement(betId, walletId, stake, expectedPayout);

  // Balance reflects exactly one money move: post-debit 9900 + (refunded stake | payout).
  const credited = winner === "cancelled" ? stake : expectedPayout;
  expect(await ledger.getBalance(walletId)).toBe(9_900n + credited);
});

test("F-081: cancelBet racing the server auto-cashout on one active bet settles exactly once", async () => {
  activeRoundId = await freshRound();
  const { userId, walletId } = await freshUser(9_800n);
  const stake = 200n;
  const autoTarget = 2.0;
  const betId = await activeBet({
    roundId: activeRoundId, userId, walletId, panel: "B", amount: stake, autoCashout: autoTarget,
  });
  const expectedPayout = stake * 2n; // stake × autoTarget (2.0x), under the win cap

  // Follower cancels while the leader's tick auto-cashes the SAME bet at its target.
  const [cancelRes, autoResults] = await Promise.all([
    followerBets.cancelBet(userId, "B"),
    leaderBets.evaluateAutoCashouts(autoTarget),
  ]);

  const autoOk = autoResults.length === 1;
  const okCount = (cancelRes.ok ? 1 : 0) + (autoOk ? 1 : 0);
  expect(okCount).toBe(1);
  if (!cancelRes.ok) expect(cancelRes.reason).toBe("no_active_bet");

  const winner = await assertExactlyOneSettlement(betId, walletId, stake, expectedPayout);

  const credited = winner === "cancelled" ? stake : expectedPayout;
  expect(await ledger.getBalance(walletId)).toBe(9_800n + credited);
});

test("F-081: high-contention — N cancels vs N cashOuts on one bet still settle exactly once", async () => {
  activeRoundId = await freshRound();
  const { userId, walletId } = await freshUser(9_950n);
  const stake = 50n;
  const betId = await activeBet({ roundId: activeRoundId, userId, walletId, panel: "A", amount: stake });
  const expectedPayout = stake * 2n;

  // Pile on: several cancels and several cash-outs all targeting the one active bet.
  const ops = [
    ...Array.from({ length: 5 }, () => followerBets.cancelBet(userId, "A")),
    ...Array.from({ length: 5 }, () => leaderBets.cashOut(userId, "A")),
  ];
  const settled = await Promise.allSettled(ops);
  expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
  const oks = settled.filter((r) => r.status === "fulfilled" && (r.value as any).ok);
  expect(oks.length).toBe(1); // exactly one winner across all 10 contenders

  const winner = await assertExactlyOneSettlement(betId, walletId, stake, expectedPayout);
  const credited = winner === "cancelled" ? stake : expectedPayout;
  expect(await ledger.getBalance(walletId)).toBe(9_950n + credited);
});
