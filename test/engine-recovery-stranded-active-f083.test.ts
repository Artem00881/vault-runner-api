import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { GameEngineService } from "../src/game/game-engine.service";

/**
 * F-083 — recoverStrandedActiveBets(): finalize a bet left `active` on a force-`completed`,
 * PRE-OUTCOME (refund-all) round whose closeAndRefundRound reverse() had failed on its first try.
 *
 * That round is `completed` + crashedAt:null (the refund-all terminal — a normally-settled round
 * always passes through `crashed`, stamping crashedAt, BEFORE `completed`). Neither
 * recoverReservingBets (reserving/cancelling only) nor recoverInterruptedRounds (OPEN rounds only)
 * rescans such a bet, so it would sit `active` with its stake stranded. The sweep re-runs the SAME
 * idempotent restart-refund (no double-pay) then CAS-flips active → cancelled.
 *
 *   (a) REFUND + FLIP (idempotent): a stranded `active` bet on completed/crashedAt:null is refunded
 *       once and flipped to `cancelled`; a second sweep does NOT double-refund.
 *   (b) GUARD CORRECTNESS: a bet `active` on a `completed` round WITH crashedAt set (an outcome-
 *       bearing / normally-settled round) is NEVER touched — its winners/losers are left alone.
 *   (c) AGE GATE: a young (fresh settledAt) stranded round is spared by the default sweep
 *       (olderThanMs=60s) but recovered by the boot semantics (olderThanMs=0) — proves the gate.
 *
 * Internal/ledger wallet mode: reverse() of a `debit` posts a `refund` CREDIT under the
 * idempotent key `bet:{id}:restart_refund` (so a re-run can't double-pay). The method is wallet-
 * mode-agnostic (operator mode is covered by the rollback-idempotency contract's once-only outbox).
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const redisStub: any = { client: { set: async () => {} } };
const fairnessStub: any = {};
// recover* never reads redis/fairness/election/cache — stubs keep the constructor arity correct.
const engine = new GameEngineService(prisma, redisStub, fairnessStub, ledger, {} as any, {} as any, {} as any);
const sweep = (olderThanMs?: number) => engine.recoverStrandedActiveBets(olderThanMs);

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];
const createdBetIds: string[] = [];

// Synthetic-epoch allocator (collision-proof high band + per-process random offset + monotonic
// counter) so @@unique(epoch) can't P2002 across the shared `bun test` process.
const EPOCH_BASE = 1_700_000_000 + Math.floor(Math.random() * 10_000_000);
let epochSeq = 0;
const nextEpoch = () => EPOCH_BASE + epochSeq++;

const debitKey = (roundId: string, userId: string, panel: string) => `bet:${roundId}:${userId}:${panel}:debit`;

/**
 * A `completed` round with an explicit crashedAt + settledAt. crashedAt:null = the refund-all
 * terminal (what closeAndRefundRound leaves); a non-null crashedAt = an outcome-bearing round.
 */
async function seedCompletedRound(opts: { crashedAt: Date | null; settledAt: Date }): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: nextEpoch(),
      commitHash: "f083c-" + randomUUID(),
      length: 2,
      salt: "f083s-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "f083h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: {
      seedId: seed.id,
      nonce: 1n,
      crashPoint: 2.0,
      status: "completed",
      bettingOpensAt: new Date(),
      crashedAt: opts.crashedAt,
      settledAt: opts.settledAt,
    },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** A funded DEMO wallet (unique username so parallel/repeat runs never collide). */
async function fundedUser(balance: bigint): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "f083_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "f083" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

/**
 * Stamp a bet stranded `active` on `roundId` AND its real stake debit under the deterministic
 * key the restart-refund reverses — i.e. the money has left the wallet but closeAndRefundRound's
 * reverse() threw, so the row never flipped to cancelled.
 */
async function strandedActiveBet(roundId: string, userId: string, walletId: string, amount: bigint): Promise<string> {
  const betId = randomUUID();
  await prisma.bet.create({
    data: { id: betId, roundId, userId, walletId, panel: "A", amount, status: "active", currency: "DEMO" },
  });
  createdBetIds.push(betId);
  await ledger.debit(walletId, amount, "bet_debit", debitKey(roundId, userId, "A"), { refType: "bet", refId: betId });
  return betId;
}

beforeAll(async () => {
  await prisma.$connect();
});
// Close any synthetic OPEN round at the end of each test so it can never survive into a later
// suite's open-round scan in the shared process (defensive — these are all `completed` already).
afterEach(async () => {
  await prisma.round.updateMany({
    where: { id: { in: createdRoundIds }, status: { in: ["waiting", "betting", "running", "crashed", "settling"] } },
    data: { status: "completed" },
  });
});
afterAll(async () => {
  // FK-safe purge (rounds → bets, then seeds/chains, then users cascade wallets/ledger/profile).
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F-083 recoverStrandedActiveBets — heal a bet stranded 'active' on a refund-all round", () => {
  test("(a) a stranded 'active' bet on completed/crashedAt:null is refunded ONCE and flipped to cancelled", async () => {
    // The round was force-completed by closeAndRefundRound but the reverse() threw → the bet sits
    // `active`, the stake (100) is OUT of the wallet. settledAt is old so the default gate passes.
    const roundId = await seedCompletedRound({ crashedAt: null, settledAt: new Date(Date.now() - 5 * 60_000) });
    const { userId, walletId } = await fundedUser(10_000n);
    const betId = await strandedActiveBet(roundId, userId, walletId, 100n);
    expect(await ledger.getBalance(walletId)).toBe(9_900n); // money is out (debited, never refunded)

    const healed = await sweep(0);
    expect(healed).toBe(1);

    // Refunded back to start; bet finalized cancelled with settledAt; the round is untouched.
    expect(await ledger.getBalance(walletId)).toBe(10_000n);
    const after = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(after.status).toBe("cancelled");
    expect(after.settledAt).not.toBeNull();

    // IDEMPOTENT: a second sweep does NOT re-select (bet is cancelled) and the refund key is
    // idempotent anyway → balance stays at start, exactly one refund credit row exists.
    const healed2 = await sweep(0);
    expect(healed2).toBe(0);
    expect(await ledger.getBalance(walletId)).toBe(10_000n); // not 10_100n

    const refunds = await prisma.ledgerTransaction.findMany({ where: { idempotencyKey: `bet:${betId}:restart_refund` } });
    expect(refunds.length).toBe(1);
    expect(refunds[0].amount).toBe(100n); // a single credit (positive)
  });

  test("(b) GUARD: a bet 'active' on a completed round WITH crashedAt set is NEVER touched (outcome-bearing)", async () => {
    // A normally-settled round passes through `crashed` (crashedAt stamped) before `completed`.
    // A stranded loser/winner there is the engine's settlement job, NOT a refund-all — the sweep
    // must leave it alone (refunding it would PAY BACK a legitimately-lost stake = money created).
    const roundId = await seedCompletedRound({ crashedAt: new Date(Date.now() - 5 * 60_000), settledAt: new Date(Date.now() - 5 * 60_000) });
    const { userId, walletId } = await fundedUser(10_000n);
    const betId = await strandedActiveBet(roundId, userId, walletId, 100n);
    expect(await ledger.getBalance(walletId)).toBe(9_900n);

    const healed = await sweep(0); // even with the most aggressive (boot) age gate
    expect(healed).toBe(0); // the crashedAt guard excludes it

    // The bet is untouched (still active, no settledAt) and NO refund was posted.
    const after = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(after.status).toBe("active");
    expect(after.settledAt).toBeNull();
    expect(await ledger.getBalance(walletId)).toBe(9_900n); // money stays out (outcome stands)
    expect(await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: `bet:${betId}:restart_refund` } })).toBeNull();
  });

  test("(c) AGE GATE: a YOUNG stranded round is spared by the default sweep (60s) but recovered by boot (0)", async () => {
    // Same refund-all terminal but freshly settled (settledAt ≈ now) — i.e. we might be racing a
    // live close. The default sweep (olderThanMs=60s) must NOT touch it; the boot path (0) does.
    const roundId = await seedCompletedRound({ crashedAt: null, settledAt: new Date() });
    const { userId, walletId } = await fundedUser(10_000n);
    const betId = await strandedActiveBet(roundId, userId, walletId, 100n);
    expect(await ledger.getBalance(walletId)).toBe(9_900n);

    // Default 60s gate: the young round is spared (settledAt is NOT < now-60s).
    const healedYoung = await sweep(); // default olderThanMs = 60_000
    expect(healedYoung).toBe(0);
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("active");
    expect(await ledger.getBalance(walletId)).toBe(9_900n); // untouched

    // Boot semantics (0) recover the SAME slot — proving the gate, not a different bug.
    const healedBoot = await sweep(0);
    expect(healedBoot).toBe(1);
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("cancelled");
    expect(await ledger.getBalance(walletId)).toBe(10_000n); // refunded
  });
});
