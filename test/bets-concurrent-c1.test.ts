import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { makeAudit } from "./helpers/audit";

/**
 * Regression for audit C1 (headline money bug).
 *
 * Two concurrent `placeBet` for the SAME (round, user, panel) used to BOTH pass
 * the unlocked "already_bet" findUnique check and BOTH debit the wallet with a
 * per-attempt key (`bet:{randomUUID}:debit`); the second bet.create hit the
 * @@unique([roundId,userId,panel]) constraint (P2002), was swallowed as
 * "bet_failed", and the orphaned second debit was NEVER refunded — the player was
 * charged TWICE for one bet.
 *
 * The fix binds the debit idempotency key to the LOGICAL bet
 * (`bet:{roundId}:{userId}:{panel}:debit`) so a concurrent duplicate dedups in
 * the ledger, and returns "already_bet" on the P2002. We assert the money
 * invariant: exactly ONE bet row, exactly ONE bet_debit ledger entry, and the
 * balance is `start - amount` (NOT `start - 2*amount`).
 *
 * Pre-fix, the balance assertion below would read `start - 2*amount` and the
 * ledger would hold two bet_debit rows — i.e. this test would FAIL, proving teeth.
 *
 * Uses the internal ledger as the WalletProvider (no operator), real RiskService
 * + MetricsService, and a fake engine pinned to the "betting" phase so the test
 * is deterministic and needs no running game loop.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();

// Fake engine: pins a deterministic round in the betting window. BetsService
// only reads getPublicState() in placeBet, so this is all it needs.
let activeRoundId = "";
const fakeEngine: any = {
  getPublicState: () => ({
    roundId: activeRoundId,
    phase: "betting",
    phaseEndsAt: Date.now() + 5000,
    multiplier: 1.0,
    serverTime: Date.now(),
  }),
  currentMultiplier: () => 1.0,
};

const bets = new BetsService(prisma, ledger, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

// Track synthetic rows for FK-safe cleanup (rounds cascade bets; users cascade
// wallets/ledger/profiles; seeds then chains last).
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];

async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 2_000_000 + Math.floor(Math.random() * 1_000_000), // synthetic epoch
      commitHash: "c1commit-" + randomUUID(),
      length: 2,
      salt: "c1salt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "c1h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "betting", bettingOpensAt: new Date() },
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
      username: "c1_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "c1" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
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

test("C1: two concurrent same-panel placeBets charge exactly once (one bet, one debit, start-amount)", async () => {
  activeRoundId = await freshRound();
  const { userId, walletId } = await freshUser(10_000n);
  const amount = 100;

  const [r1, r2] = await Promise.all([
    bets.placeBet(userId, "A", amount),
    bets.placeBet(userId, "A", amount),
  ]);

  // Exactly one attempt wins; the other is cleanly rejected as already_bet (not
  // a swallowed "bet_failed" that hides a stranded debit).
  const oks = [r1, r2].filter((r) => r.ok);
  const rejected = [r1, r2].filter((r) => !r.ok);
  expect(oks.length).toBe(1);
  expect(rejected.length).toBe(1);
  expect(rejected[0].reason).toBe("already_bet");

  // Exactly ONE bet row for this (round,user,panel).
  const betRows = await prisma.bet.findMany({ where: { roundId: activeRoundId, userId, panel: "A" } });
  expect(betRows.length).toBe(1);

  // Exactly ONE bet_debit ledger entry on the wallet.
  const debits = await prisma.ledgerTransaction.findMany({ where: { walletId, type: "bet_debit" } });
  expect(debits.length).toBe(1);
  expect(debits[0].amount).toBe(-BigInt(amount));

  // THE invariant: balance == start - amount (NOT start - 2*amount).
  expect(await ledger.getBalance(walletId)).toBe(10_000n - BigInt(amount));
});

test("C1: a high-contention burst of identical placeBets still charges exactly once", async () => {
  // Same logical bet fired many times in parallel — stresses the dedup path. The
  // ledger debit key is deterministic, so all duplicates collapse to one charge.
  activeRoundId = await freshRound();
  const { userId, walletId } = await freshUser(10_000n);
  const amount = 250;

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => bets.placeBet(userId, "A", amount)),
  );
  // No attempt throws: every duplicate resolves to ok or a clean rejection.
  expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  const oks = results.filter((r) => r.status === "fulfilled" && (r.value as any).ok);
  expect(oks.length).toBe(1);

  const betRows = await prisma.bet.findMany({ where: { roundId: activeRoundId, userId } });
  expect(betRows.length).toBe(1);
  const debits = await prisma.ledgerTransaction.findMany({ where: { walletId, type: "bet_debit" } });
  expect(debits.length).toBe(1);
  expect(await ledger.getBalance(walletId)).toBe(10_000n - BigInt(amount));
});

test("C1 sanity: distinct panels A and B are separate bets and each charges once", async () => {
  // Guards against an over-eager fix that would dedup across panels. A and B
  // share a (round,user) but are different logical bets → two debits.
  activeRoundId = await freshRound();
  const { userId, walletId } = await freshUser(10_000n);

  const [a, b] = await Promise.all([
    bets.placeBet(userId, "A", 100),
    bets.placeBet(userId, "B", 200),
  ]);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);

  const betRows = await prisma.bet.findMany({ where: { roundId: activeRoundId, userId } });
  expect(betRows.length).toBe(2);
  const debits = await prisma.ledgerTransaction.findMany({ where: { walletId, type: "bet_debit" } });
  expect(debits.length).toBe(2);
  expect(await ledger.getBalance(walletId)).toBe(10_000n - 300n);
});
