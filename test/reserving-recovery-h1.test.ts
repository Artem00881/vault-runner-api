import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { GameEngineService } from "../src/game/game-engine.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { makeAudit } from "./helpers/audit";

/**
 * Regression for audit H1 *review* (stranded-debit): money is NEVER destroyed
 * when a bet's debit succeeds but the flip 'reserving'→'active' fails.
 * `src/game/bets.service.ts` PHASE 2, `src/game/game-engine.service.ts`
 * recoverReservingBets(), docs/audit-2026-06-03.md H1.
 *
 * THE FIX under test:
 *  - placeBet PHASE 2 now separates the debit from the activation. A debit
 *    FAILURE deletes the reserving slot (no money moved). A debit SUCCESS that
 *    then fails to flip the row to 'active' leaves the row 'reserving' (debitTxId
 *    best-effort stamped) — it is NOT deleted, because that would strand a real
 *    debit (money out, no bet).
 *  - GameEngineService.recoverReservingBets() (run from recoverInterruptedRounds()
 *    on boot, the same entry engine-recovery.test.ts drives) uses the LEDGER as
 *    the source of truth: a 'reserving' bet WITH a matching ledger debit
 *    (key `bet:{roundId}:{userId}:{panel}:debit`) is REFUNDED + cancelled; one
 *    WITHOUT a debit moved no money and is just deleted. The refund credit key
 *    `bet:{id}:restart_refund` is idempotent, so a crash-loop reboot can't
 *    double-refund.
 *
 * THE INVARIANT (was violated): conservation of money. A paid-but-unactivated
 * bet must be recoverable to a full refund; an unpaid reservation must leave the
 * balance untouched. We assert both, plus restart-idempotency.
 *
 * Drives recovery through the SAME private entry the engine uses on start
 * (recoverInterruptedRounds → recoverReservingBets), mirroring
 * engine-recovery.test.ts. Internal ledger as the WalletProvider; fairness/redis
 * are unused by recovery so they are stubbed.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const redisStub: any = { client: { set: async () => {} } };
const fairnessStub: any = {};
const engine = new GameEngineService(prisma, redisStub, fairnessStub, ledger, {} as any, {} as any, {} as any);
// recoverReservingBets() is private; drive it via recoverInterruptedRounds() —
// the exact entry start() calls on boot (engine-recovery.test.ts does the same).
const recover = () => (engine as any).recoverInterruptedRounds();

// Deterministic debit key the recovery treats as the source of truth.
const debitKey = (roundId: string, userId: string, panel: string) =>
  `bet:${roundId}:${userId}:${panel}:debit`;

// Track synthetic rows for FK-safe cleanup (rounds cascade their bets; users
// cascade wallets/ledger/profiles; seeds then chains last). Synthetic epochs are
// far above any real epoch so we never touch live fairness data.
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];

async function seedCompletedRound(): Promise<string> {
  // A completed round is enough: recoverReservingBets() runs regardless of round
  // status, and 'completed' means recoverInterruptedRounds' OTHER branch (which
  // refunds *active* bets of OPEN rounds) won't touch our reserving rows — so we
  // isolate exactly the reserving-recovery path.
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 3_000_000 + Math.floor(Math.random() * 1_000_000), // synthetic epoch
      commitHash: "h1rcommit-" + randomUUID(),
      length: 2,
      salt: "h1rsalt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "h1rh-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "completed", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function seedBettingRound(): Promise<string> {
  // For the real placeBet path we need a round in the betting window.
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 3_000_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "h1rcommit-" + randomUUID(),
      length: 2,
      salt: "h1rsalt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "h1rh-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "betting", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function fundedUser(balance: bigint): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "h1r_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "h1r" } },
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
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

// 1) DEBITED-BUT-STUCK 'reserving' bet (the stranded-debit case) → REFUNDED.
test("H1: a debited 'reserving' bet (debit applied, never activated) is refunded by recovery, idempotently", async () => {
  const roundId = await seedCompletedRound();
  const { userId, walletId } = await fundedUser(10_000n);
  const betId = randomUUID();

  // Stamp the reserving slot AND the real ledger debit, exactly as the
  // post-debit/pre-activation crash state: the money has left the wallet but the
  // row never flipped to 'active'. ledger.debit reduces the balance to 9900 and
  // writes the bet_debit row under the deterministic key recovery looks up.
  await prisma.bet.create({
    data: { id: betId, roundId, userId, walletId, panel: "A", amount: 100n, status: "reserving", currency: "DEMO" },
  });
  const tx = await ledger.debit(walletId, 100n, "bet_debit", debitKey(roundId, userId, "A"), {
    refType: "bet",
    refId: betId,
  });
  // best-effort debitTxId stamp the real placeBet would attempt — proves recovery
  // works whether or not it landed (it uses the LEDGER, not this column).
  await prisma.bet.update({ where: { id: betId }, data: { debitTxId: tx.id } });
  expect(await ledger.getBalance(walletId)).toBe(9_900n); // money is out

  await recover();

  // Refunded back to start, bet cancelled (not left dangling), settledAt stamped.
  expect(await ledger.getBalance(walletId)).toBe(10_000n);
  const after = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(after.status).toBe("cancelled");
  expect(after.settledAt).not.toBeNull();

  // A second recovery pass (crash-loop on boot) must NOT double-refund. The bet is
  // already 'cancelled' (so not re-selected) AND the restart_refund credit key is
  // idempotent — belt and suspenders. Balance stays at start.
  await recover();
  expect(await ledger.getBalance(walletId)).toBe(10_000n); // not 10_100n

  // Exactly one refund (credit) ledger row exists for this bet.
  const refunds = await prisma.ledgerTransaction.findMany({
    where: { idempotencyKey: `bet:${betId}:restart_refund` },
  });
  expect(refunds.length).toBe(1);
  expect(refunds[0].amount).toBe(100n); // credit (positive)
});

// 2) RESERVING WITH NO LEDGER DEBIT → DELETED, balance untouched.
test("H1: a 'reserving' bet with NO ledger debit moved no money — recovery deletes it, balance unchanged", async () => {
  const roundId = await seedCompletedRound();
  const { walletId, userId } = await fundedUser(10_000n);
  const betId = randomUUID();

  // A reservation that never debited (e.g. crashed between insert and debit, or a
  // debit that threw and the slot wasn't yet dropped). No bet_debit row exists.
  await prisma.bet.create({
    data: { id: betId, roundId, userId, walletId, panel: "A", amount: 100n, status: "reserving", currency: "DEMO" },
  });
  expect(await ledger.getBalance(walletId)).toBe(10_000n);

  await recover();

  // The slot is gone (no exposure dust), and NOT refunded (no money had moved).
  expect(await prisma.bet.findUnique({ where: { id: betId } })).toBeNull();
  expect(await ledger.getBalance(walletId)).toBe(10_000n);
  // No phantom refund credit was written.
  const refunds = await prisma.ledgerTransaction.findMany({
    where: { idempotencyKey: `bet:${betId}:restart_refund` },
  });
  expect(refunds.length).toBe(0);
});

// 3) The REAL placeBet activation-failure path: debit succeeds, the flip to
// 'active' throws → the row stays 'reserving' with the money debited (NOT
// deleted), and recovery then refunds it. Proves the fix end-to-end through the
// production code, not just a hand-seeded reserving row.
test("H1: real placeBet — debit succeeds but activation update throws → bet left recoverable (money preserved), then refunded", async () => {
  const roundId = await seedBettingRound();
  const { userId, walletId } = await fundedUser(10_000n);

  // A prisma whose bet.updateMany ALWAYS throws (simulates the post-debit
  // activation failing — DB blip / row lock / connection drop). placeBet's PHASE 2
  // flip 'reserving'→'active' is a compare-and-swap via bet.updateMany (audit
  // Low-1), and so is the best-effort debitTxId stamp on failure — so BOTH go
  // through updateMany and must throw to reproduce the activation-failure state.
  // (bet.update is also stubbed to throw, belt-and-suspenders, in case the flip is
  // ever changed back.) Everything else is the real prisma so the reserve insert
  // (PHASE 1 runs in $transaction → tx.bet.create, the interactive-tx client, NOT
  // this.prisma.bet, so it is NOT intercepted here) and the ledger debit (real
  // money movement) actually happen. placeBet calls bet.updateMany up to 3x to
  // flip, then once more (caught) to stamp debitTxId — all throw — so the row must
  // survive as 'reserving'.
  const failingPrisma: any = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === "bet") {
        const realBet = (target as any).bet;
        return new Proxy(realBet, {
          get(bt, p, r) {
            if (p === "update" || p === "updateMany") {
              return async () => {
                throw new Error("simulated activation failure (DB blip)");
              };
            }
            return Reflect.get(bt, p, r);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const risk = new RiskService();
  const metrics = new MetricsService();
  let bettingRoundId = roundId;
  const fakeEngine: any = {
    getPublicState: () => ({
      roundId: bettingRoundId,
      phase: "betting",
      phaseEndsAt: Date.now() + 5000,
      multiplier: 1.0,
      serverTime: Date.now(),
    }),
    currentMultiplier: () => 1.0,
  };
  // BetsService uses failingPrisma for its own writes, but the REAL ledger (over
  // the real prisma) for the debit — so the money genuinely moves and recovery
  // (also real prisma) can find the debit row.
  const bets = new BetsService(failingPrisma, ledger, fakeEngine, risk, metrics, makeAudit(failingPrisma, metrics));

  const res = await bets.placeBet(userId, "A", 100);

  // placeBet reports failure (activation never completed)...
  expect(res.ok).toBe(false);
  expect(res.reason).toBe("bet_failed");

  // ...but the money WAS debited (9900) and the row is preserved as 'reserving'
  // (NOT deleted) so it is recoverable — this is the whole point of the fix.
  expect(await ledger.getBalance(walletId)).toBe(9_900n);
  const stuck = await prisma.bet.findFirstOrThrow({ where: { roundId, userId, panel: "A" } });
  expect(stuck.status).toBe("reserving");
  // Track for cleanup (id was generated inside placeBet).
  const reservedBetId = stuck.id;
  const debit = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey: debitKey(roundId, userId, "A") },
  });
  expect(debit).not.toBeNull(); // the source-of-truth debit exists

  // Recovery (real prisma + real ledger) now refunds the stranded debit.
  await recover();
  expect(await ledger.getBalance(walletId)).toBe(10_000n); // money restored
  expect((await prisma.bet.findUniqueOrThrow({ where: { id: reservedBetId } })).status).toBe("cancelled");

  // Idempotent on a second pass.
  await recover();
  expect(await ledger.getBalance(walletId)).toBe(10_000n);
});
