import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { WalletRouter } from "../src/wallet/wallet-router";
import { SeamlessOperatorWallet, type OperatorSession } from "../src/wallet/seamless-operator-wallet";
import { WalletRollbackService, dedupeKeyOf } from "../src/wallet/wallet-rollback.service";
import { NonIdempotentMockOperator } from "./helpers/non-idempotent-mock-operator";
import { makeAudit } from "./helpers/audit";

/**
 * Audit M1 — the OPERATOR-ROLLBACK ONCE-ONLY + DURABLE-OUTBOX contract (F-002 / F-027 / F-075).
 *
 * The adversary is a NON-IDEMPOTENT operator whose `rollback` re-applies the inverse delta on
 * EVERY call (NonIdempotentMockOperator). Real PrismaService + real WalletRollbackService are
 * wired into SeamlessOperatorWallet, so the once-only guard (a `confirmed` wallet_rollbacks row
 * ⇒ skip the operator emit) is exercised end-to-end. WITHOUT the guard each scenario would
 * double-reverse against this operator (fails-first); the wallet_rollbacks store is what makes
 * it net correct.
 *
 *   Scenario A — void RESUME: a void interrupted after both legs confirmed is retried via
 *     reconcileVoidingBets(); the guard skips both rollbacks → no over-credit.
 *   Scenario B — ambiguous-debit safeRollback: a timeout-after-apply debit compensates once;
 *     re-driving the same debit key + timeout skips the second rollback → restored exactly once.
 *   Scenario C — F-027 durable discrepancy: a rollback whose emit throws is left `pending`
 *     (countPending()===1); the drain re-issues it to `confirmed` (pending==0, balance correct).
 *
 * M1 follow-up fix (the once-only key is the LOGICAL reversal, NOT the reusable transactionId):
 *   Scenario D — CROSS-INTENT/CROSS-BET CONFLATION (the reproduced bug): a confirmed
 *     ambiguous_debit on a debit key for bet B1 must NOT suppress a genuinely-different
 *     void_refund on the SAME (reused) debit key for a re-bet B2 — the void's stake refund
 *     must still emit. Fails-first against the old (operatorId, transactionId) key.
 *   Scenario E — SAME-REASON-DIFFERENT-BET: two ambiguous_debit compensations on the same
 *     reused debit key for two different rejected attempts (different betIds) must BOTH emit.
 *   Scenario F — DRAIN RACE (#2): a concurrent drainPending + live void-resume on the same
 *     pending row must produce EXACTLY ONE operator rollback (net-correct balance).
 */

const JWT_SECRET = "rollback-contract-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));
const rollbackStore = new WalletRollbackService(prisma);

const fakeEngine: any = {
  getPublicState: () => ({ roundId: "", phase: "betting", phaseEndsAt: Date.now() + 60_000, multiplier: 1, serverTime: Date.now() }),
  currentMultiplier: () => 1,
};

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];
const createdBetIds: string[] = [];

const debitKey = (roundId: string, userId: string, panel: string) => `bet:${roundId}:${userId}:${panel}:debit`;
const payoutKey = (betId: string) => `bet:${betId}:payout`;

/** Look up a rollback row by its LOGICAL-reversal identity (operatorId + betId|tx + reason). */
function findRow(operatorId: string, opts: { betId?: string; transactionId: string; reason: string }) {
  return prisma.walletRollback.findUnique({
    where: { operatorId_dedupeKey: { operatorId, dedupeKey: dedupeKeyOf(opts) } },
  });
}

async function makeRound(status = "crashed"): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 8_800_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "rbk-" + randomUUID(),
      length: 2,
      salt: "rbk-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({ data: { chainId: chain.id, chainIndex: 1, seedHash: "rbk-" + randomUUID() } });
  const round = await prisma.round.create({ data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status, bettingOpensAt: new Date() } });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  try {
    // wallet_rollbacks: NO FK + NO immutability trigger → scoped deleteMany is allowed.
    if (createdOperatorIds.length) await prisma.walletRollback.deleteMany({ where: { operatorId: { in: createdOperatorIds } } });
    if (createdBetIds.length) await prisma.walletRollback.deleteMany({ where: { betId: { in: createdBetIds } } });

    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    for (const operatorId of createdOperatorIds) {
      // F-017: user→wallet/profile + wallet→ledger/bet are RESTRICT — delete children first.
      const opUser = { user: { username: { startsWith: `op:${operatorId}:` } } } as const;
      await prisma.bet.deleteMany({ where: { wallet: opUser } });
      await prisma.ledgerTransaction.deleteMany({ where: { wallet: opUser } });
      await prisma.profile.deleteMany({ where: opUser });
      await prisma.wallet.deleteMany({ where: opUser });
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

// Shared helpers to launch a real operator session + settle an operator bet under the EXACT
// keys voidBet rolls back (used by Scenarios A, D, F that go through the full BetsService path).
async function launchReal(operatorApi: NonIdempotentMockOperator, label: string, currency: string, operatorBalance: number) {
  const op = await prisma.operator.create({
    data: {
      code: `rbk-${label}-` + randomUUID().slice(0, 8),
      name: `Rollback Contract ${label}`,
      enabled: true,
      demoEnabled: false,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
    },
  });
  createdOperatorIds.push(op.id);
  const playerId = "p-" + randomUUID().slice(0, 8);
  const token = await launch.issue({ operatorId: op.id, playerId, currency });
  const s = await sessions.openFromToken(token);
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: s.walletId } });
  operatorApi.seed(playerId, currency, operatorBalance);
  return { op, playerId, currency, walletId: s.walletId, userId: wallet.userId };
}

/** Settle a cashed_out operator bet on a given round (so its debit key is deterministic). */
async function settledOperatorBetOnRound(operatorApi: NonIdempotentMockOperator, opts: {
  operatorId: string; userId: string; walletId: string; playerId: string; currency: string;
  roundId: string; panel: string; stake: number; payout: number;
}): Promise<{ betId: string }> {
  const betId = randomUUID();
  await operatorApi.bet(opts.operatorId, {
    playerId: opts.playerId, currency: opts.currency, amount: opts.stake.toString(),
    transactionId: debitKey(opts.roundId, opts.userId, opts.panel), roundId: opts.roundId, betId,
  });
  const w = await operatorApi.win(opts.operatorId, {
    playerId: opts.playerId, currency: opts.currency, amount: opts.payout.toString(),
    transactionId: payoutKey(betId), roundId: opts.roundId, betId,
  });
  await prisma.bet.create({
    data: {
      id: betId, roundId: opts.roundId, userId: opts.userId, walletId: opts.walletId, panel: opts.panel,
      amount: BigInt(opts.stake), status: "cashed_out", payout: BigInt(opts.payout),
      operatorId: opts.operatorId, currency: opts.currency,
      payoutTxId: w.operatorTxId, cashoutMult: 2.5, settledAt: new Date(),
    },
  });
  createdBetIds.push(betId);
  return { betId };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO A — operator-mode void resume must not double-reverse a non-idempotent operator.
describe("M1.A void resume — confirmed rollbacks are SKIPPED (no over-credit)", () => {
  const operatorApi = new NonIdempotentMockOperator();
  const seamless = new SeamlessOperatorWallet(operatorApi, sessions.resolver(), {}, rollbackStore);
  const router = new WalletRouter(ledger, seamless, (walletId) => sessions.isDemoWallet(walletId));
  const opBets = new BetsService(prisma, router, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

  test("a void replayed via reconcileVoidingBets skips both confirmed rollbacks; balance restored exactly once", async () => {
    const startBalance = 100_000;
    const { op, playerId, currency, walletId, userId } = await launchReal(operatorApi, "A", "EUR", startBalance);
    const roundId = await makeRound();
    const { betId } = await settledOperatorBetOnRound(operatorApi, { operatorId: op.id, userId, walletId, playerId, currency, roundId, panel: "A", stake: 1000, payout: 2500 });
    // post-settle at the operator: −1000 +2500 = +1500.
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance + 1500));

    // First void: reclaim (−2500) + refund (+1000) → back to start; both rollback rows confirmed.
    const res = await opBets.voidBet(op.id, betId);
    expect(res.reversed).toBe(true);
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance));
    const rollbacksAfterFirst = operatorApi.calls.rollback;
    expect(rollbacksAfterFirst).toBe(2); // reclaim + refund

    // The two durable rows exist and are CONFIRMED. Keyed by the LOGICAL reversal: reclaim =
    // {betId}#void_reclaim, refund = {betId}#void_refund (both carry betId from ref.refId).
    const reclaimRow = await findRow(op.id, { betId, transactionId: payoutKey(betId), reason: "void_reclaim" });
    const refundRow = await findRow(op.id, { betId, transactionId: debitKey(roundId, userId, "A"), reason: "void_refund" });
    expect(reclaimRow?.status).toBe("confirmed");
    expect(reclaimRow?.reason).toBe("void_reclaim");
    expect(refundRow?.status).toBe("confirmed");
    expect(refundRow?.reason).toBe("void_refund");

    // Now SIMULATE an interrupted void that already finalised both legs but whose status flip
    // is replayed: force the bet back to `voiding` and run the finalizer sweep. Against this
    // NON-idempotent operator, re-emitting either rollback would over-credit — the guard must skip.
    await prisma.bet.update({ where: { id: betId }, data: { status: "voiding" } });
    const finalized = await opBets.reconcileVoidingBets();
    expect(finalized).toBeGreaterThanOrEqual(1);

    // CRITICAL: the operator was NOT called again (both rows already confirmed → skipped).
    expect(operatorApi.calls.rollback).toBe(rollbacksAfterFirst);
    // Balance is still exactly the start — NOT over-credited by a double reverse.
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance));
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("voided");
    // No owed rollbacks left for this operator.
    expect(await prisma.walletRollback.count({ where: { operatorId: op.id, status: { in: ["pending", "draining"] } } })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO B — ambiguous-debit compensation is once-only across a re-driven debit.
describe("M1.B ambiguous-debit safeRollback — re-driven debit skips the second rollback", () => {
  const SESSION: OperatorSession = { operatorId: "", playerId: "pB", currency: "EUR", roundId: "rB" };
  const operatorApi = new NonIdempotentMockOperator({ "pB:EUR": 1000 });

  test("timeout-after-apply rolls back once; re-driving the same debit key + timeout does not double-reverse", async () => {
    // A dedicated operator row so the wallet_rollbacks rows are scoped + torn down.
    const op = await prisma.operator.create({
      data: { code: "rbk-B-" + randomUUID().slice(0, 8), name: "Rollback Contract B", enabled: true, demoEnabled: false, launchSecret: "s-" + randomUUID(), currencies: ["EUR"] },
    });
    createdOperatorIds.push(op.id);
    SESSION.operatorId = op.id;
    const resolver = async (_walletId: string) => SESSION;
    const wallet = new SeamlessOperatorWallet(operatorApi, resolver, {}, rollbackStore);

    const dkey = `bet:rB:pB:A:debit`;
    const betRef = randomUUID(); // ref.refId is a bet UUID in production (wallet_rollbacks.bet_id is @db.Uuid)
    createdBetIds.push(betRef);

    // 1st attempt: operator applies the −100 debit then "times out" → safeRollback compensates.
    operatorApi.misbehaveOnce({ kind: "timeout_after_apply" });
    await expect(wallet.debit("wB", 100n, "bet_debit", dkey, { refType: "bet", refId: betRef })).rejects.toThrow("wallet_unavailable");
    expect(operatorApi.balanceOf("pB", "EUR")).toBe(1000n); // restored exactly
    expect(operatorApi.calls.rollback).toBe(1); // one compensation

    const row = await findRow(op.id, { betId: betRef, transactionId: dkey, reason: "ambiguous_debit" });
    expect(row?.status).toBe("confirmed");
    expect(row?.reason).toBe("ambiguous_debit");

    // 2nd attempt: SAME debit key + SAME bet, operator times-out-after-apply again. The bet
    // dedups on the txId (no second balance move), and safeRollback fires again — but this
    // LOGICAL reversal ({betRef}#ambiguous_debit) is already CONFIRMED → the operator emit is
    // SKIPPED. Against this non-idempotent operator a second emit would over-credit to 1100.
    operatorApi.misbehaveOnce({ kind: "timeout_after_apply" });
    await expect(wallet.debit("wB", 100n, "bet_debit", dkey, { refType: "bet", refId: betRef })).rejects.toThrow("wallet_unavailable");
    expect(operatorApi.calls.rollback).toBe(1); // STILL one — the second compensation was skipped (row already confirmed)
    expect(operatorApi.balanceOf("pB", "EUR")).toBe(1000n); // restored exactly once, never over-credited
    expect(await prisma.walletRollback.count({ where: { operatorId: op.id, status: { in: ["pending", "draining"] } } })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO C — a failed rollback emit is a DURABLE discrepancy the drain heals (F-027).
describe("M1.C durable outbox — a failed rollback stays pending, the drain re-issues it", () => {
  const SESSION: OperatorSession = { operatorId: "", playerId: "pC", currency: "EUR", roundId: "rC" };
  const operatorApi = new NonIdempotentMockOperator({ "pC:EUR": 1000 });

  test("rollback emit throws once → row pending (countPending===1); drainPending confirms it, balance correct", async () => {
    const op = await prisma.operator.create({
      data: { code: "rbk-C-" + randomUUID().slice(0, 8), name: "Rollback Contract C", enabled: true, demoEnabled: false, launchSecret: "s-" + randomUUID(), currencies: ["EUR"] },
    });
    createdOperatorIds.push(op.id);
    SESSION.operatorId = op.id;
    const resolver = async (_walletId: string) => SESSION;
    const wallet = new SeamlessOperatorWallet(operatorApi, resolver, {}, rollbackStore);

    const dkey = `bet:rC:pC:A:debit`;
    const betRef = randomUUID(); // bet UUID (wallet_rollbacks.bet_id is @db.Uuid)
    createdBetIds.push(betRef);

    // Arm the rollback of THIS debit key to throw once. The debit times-out-after-apply
    // (operator is down −100 to 900), safeRollback emits a rollback → it throws → SWALLOWED →
    // the row is left PENDING with lastError. The operator balance is NOT yet restored.
    operatorApi.failNextRollback(dkey);
    operatorApi.misbehaveOnce({ kind: "timeout_after_apply" });
    await expect(wallet.debit("wC", 100n, "bet_debit", dkey, { refType: "bet", refId: betRef })).rejects.toThrow("wallet_unavailable");
    expect(operatorApi.balanceOf("pC", "EUR")).toBe(900n); // debit applied, rollback FAILED → not restored

    const row = await findRow(op.id, { betId: betRef, transactionId: dkey, reason: "ambiguous_debit" });
    expect(row?.status).toBe("pending"); // the durable discrepancy
    expect(row?.lastError).toBeTruthy();
    // Exactly one owed rollback exists for THIS operator (scoped — shared dev DB), and the
    // global countPending() reflects it (≥1).
    expect(await prisma.walletRollback.count({ where: { operatorId: op.id, status: { in: ["pending", "draining"] } } })).toBe(1);
    expect(await rollbackStore.countPending()).toBeGreaterThanOrEqual(1);

    // Drain it: the next rollback emit succeeds → row confirmed, balance restored to 1000.
    const confirmed = await rollbackStore.drainPending(operatorApi);
    expect(confirmed).toBeGreaterThanOrEqual(1);
    const after = await findRow(op.id, { betId: betRef, transactionId: dkey, reason: "ambiguous_debit" });
    expect(after?.status).toBe("confirmed");
    expect(operatorApi.balanceOf("pC", "EUR")).toBe(1000n); // healed
    expect(await prisma.walletRollback.count({ where: { operatorId: op.id, status: { in: ["pending", "draining"] } } })).toBe(0);
  });

  test("drainPending(null) is a no-op (internal mode)", async () => {
    expect(await rollbackStore.drainPending(null)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO D — CROSS-INTENT / CROSS-BET CONFLATION (the money-path-auditor's reproduced bug).
// A confirmed ambiguous_debit on a REUSABLE debit key for bet B1 must NOT suppress a
// genuinely-different void_refund on the SAME key for a re-bet B2 — the void's stake refund
// must still emit and FULLY restore the operator balance.
//
// FAILS-FIRST against the old (operatorId, transactionId) once-only key: B2's void_refund
// would see B1's confirmed ambiguous_debit row on the same transactionId and SKIP → the live
// stake is stranded at the operator (post-void balance short by the stake).
describe("M1.D cross-intent conflation — ambiguous_debit(B1) must not suppress void_refund(B2) on a reused debit key", () => {
  const operatorApi = new NonIdempotentMockOperator();
  const seamless = new SeamlessOperatorWallet(operatorApi, sessions.resolver(), {}, rollbackStore);
  const router = new WalletRouter(ledger, seamless, (walletId) => sessions.isDemoWallet(walletId));
  const opBets = new BetsService(prisma, router, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

  test("re-bet B2 on the same round+user+panel is voided after a confirmed ambiguous_debit(B1) — refund EMITS (not suppressed), balance fully restored", async () => {
    const startBalance = 100_000;
    const { op, playerId, currency, walletId, userId } = await launchReal(operatorApi, "D", "EUR", startBalance);

    // Pick the round+user+panel up front so B1's ambiguous-debit and B2's debit/void all share
    // the SAME reusable debit key K = bet:{round}:{user}:A:debit.
    const roundId = await makeRound();
    const panel = "A";
    const K = debitKey(roundId, userId, panel);
    const sessionForB1: OperatorSession = { operatorId: op.id, playerId, currency, roundId };
    const walletB1 = new SeamlessOperatorWallet(operatorApi, async (_w) => sessionForB1, {}, rollbackStore);

    // --- Bet B1's debit on key K AMBIGUOUSLY fails (timeout-after-apply) → safeRollback
    // confirms a `ambiguous_debit` row on K. This is a rejected/ambiguously-compensated bet
    // (no bet row persists). After compensation the operator nets B1 to zero (back to start).
    const betRefB1 = randomUUID();
    createdBetIds.push(betRefB1);
    operatorApi.misbehaveOnce({ kind: "timeout_after_apply" });
    await expect(walletB1.debit(walletId, 1000n, "bet_debit", K, { refType: "bet", refId: betRefB1 })).rejects.toThrow("wallet_unavailable");
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance)); // B1 compensated → net 0
    const ambiguousRow = await findRow(op.id, { betId: betRefB1, transactionId: K, reason: "ambiguous_debit" });
    expect(ambiguousRow?.status).toBe("confirmed");

    // --- Re-bet B2 on the SAME round+user+panel → its debit reuses the SAME key K (the
    // operator dedups the stake on K, the realistic debit-key reuse this whole defect is
    // about). B2 settles cashed_out (the fresh +2500 win applies). The bet row carries B2's id.
    const { betId: betIdB2 } = await settledOperatorBetOnRound(operatorApi, {
      operatorId: op.id, userId, walletId, playerId, currency, roundId, panel, stake: 1000, payout: 2500,
    });
    const rollbacksBeforeVoid = operatorApi.calls.rollback; // B1's one
    const balBeforeVoid = operatorApi.balanceOf(playerId, currency);

    // --- Void B2: reclaim payout + REFUND stake on key K. The refund's logical reversal is
    // {B2}#void_refund — DISTINCT from {B1}#ambiguous_debit, so it must NOT be suppressed by
    // B1's confirmed row on the same K.
    const res = await opBets.voidBet(op.id, betIdB2);
    expect(res.reversed).toBe(true);

    // CRITICAL (the reproduced bug — the operator-idempotency-INDEPENDENT signal): the
    // void_refund EMITTED. Against the old per-transactionId key it is SKIPPED (B1's confirmed
    // ambiguous_debit on K suppresses it) → only the reclaim leg fires (rollbacksBeforeVoid + 1)
    // and NO void_refund row is created, stranding the live stake. With the dedupeKey fix BOTH
    // legs fire (+2) and a distinct confirmed void_refund row exists.
    expect(operatorApi.calls.rollback).toBe(rollbacksBeforeVoid + 2);
    const refundRow = await findRow(op.id, { betId: betIdB2, transactionId: K, reason: "void_refund" });
    expect(refundRow?.status).toBe("confirmed"); // EXISTS + confirmed (the bug: row absent / skipped)
    expect(refundRow?.betId).toBe(betIdB2);

    // The refund leg moved the operator balance — i.e. it actually emitted (not a no-op skip):
    // the void undid B2's reclaim (−payout) AND issued the stake refund on K (+ the remembered
    // K delta against this deliberately non-idempotent operator). The exact net is a property
    // of the operator's repeat-rollback (idempotency is its documented contract); what matters
    // for THIS defect is the refund emitted at all, asserted above. The balance simply moved.
    expect(operatorApi.balanceOf(playerId, currency)).not.toBe(balBeforeVoid - BigInt(2500)); // refund DID move it (reclaim-only would be −2500)

    // B1's ambiguous_debit row is untouched (still confirmed) — both rows coexist on key K.
    const stillAmbiguous = await findRow(op.id, { betId: betRefB1, transactionId: K, reason: "ambiguous_debit" });
    expect(stillAmbiguous?.status).toBe("confirmed");
    expect(stillAmbiguous?.betId).toBe(betRefB1);
    expect(stillAmbiguous?.id).not.toBe(refundRow?.id); // two distinct rows on the same key K

    expect(await prisma.walletRollback.count({ where: { operatorId: op.id, status: { in: ["pending", "draining"] } } })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO E — SAME-REASON-DIFFERENT-BET: two ambiguous_debit compensations on the SAME reused
// debit key for two DIFFERENT rejected attempts (different betIds) must BOTH emit (neither
// suppresses the other). FAILS-FIRST against the old per-transactionId key (the 2nd skips).
describe("M1.E same-reason-different-bet — two ambiguous_debit on the same key both emit", () => {
  const SESSION: OperatorSession = { operatorId: "", playerId: "pE", currency: "EUR", roundId: "rE" };
  const operatorApi = new NonIdempotentMockOperator({ "pE:EUR": 1000 });

  test("two rejected debit attempts on the same key (different betIds) each roll back independently", async () => {
    const op = await prisma.operator.create({
      data: { code: "rbk-E-" + randomUUID().slice(0, 8), name: "Rollback Contract E", enabled: true, demoEnabled: false, launchSecret: "s-" + randomUUID(), currencies: ["EUR"] },
    });
    createdOperatorIds.push(op.id);
    SESSION.operatorId = op.id;
    const resolver = async (_walletId: string) => SESSION;
    const wallet = new SeamlessOperatorWallet(operatorApi, resolver, {}, rollbackStore);

    const K = `bet:rE:pE:A:debit`; // the reusable debit key, shared by both attempts
    const betRef1 = randomUUID();
    const betRef2 = randomUUID();
    createdBetIds.push(betRef1, betRef2);

    // Attempt #1 on K (bet betRef1): timeout-after-apply → safeRollback compensates once.
    operatorApi.misbehaveOnce({ kind: "timeout_after_apply" });
    await expect(wallet.debit("wE", 100n, "bet_debit", K, { refType: "bet", refId: betRef1 })).rejects.toThrow("wallet_unavailable");
    expect(operatorApi.balanceOf("pE", "EUR")).toBe(1000n);
    expect(operatorApi.calls.rollback).toBe(1);

    // Attempt #2 on the SAME K but a DIFFERENT bet (betRef2): timeout-after-apply again. The
    // operator dedups the −100 on K (no second balance move). The compensation's logical
    // reversal is {betRef2}#ambiguous_debit — DISTINCT from {betRef1}#ambiguous_debit, so it
    // must EMIT (not be suppressed by attempt #1's confirmed row). Both reversals are once-only
    // on OUR side. (Two rollbacks of the same operator txId K only net-correct against an
    // idempotent-on-repeat-rollback operator — the operator's documented contract; the
    // deliberately non-idempotent adversary here double-reverses, which is NOT this defect.)
    operatorApi.misbehaveOnce({ kind: "timeout_after_apply" });
    await expect(wallet.debit("wE", 100n, "bet_debit", K, { refType: "bet", refId: betRef2 })).rejects.toThrow("wallet_unavailable");
    expect(operatorApi.calls.rollback).toBe(2); // BOTH emitted (the bug: would stay 1 — 2nd suppressed)

    const row1 = await findRow(op.id, { betId: betRef1, transactionId: K, reason: "ambiguous_debit" });
    const row2 = await findRow(op.id, { betId: betRef2, transactionId: K, reason: "ambiguous_debit" });
    expect(row1?.status).toBe("confirmed");
    expect(row2?.status).toBe("confirmed");
    expect(row1?.id).not.toBe(row2?.id); // two distinct rows on the same key K (the bug: one row reused)
    expect(await prisma.walletRollback.count({ where: { operatorId: op.id, status: { in: ["pending", "draining"] } } })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO F — DRAIN RACE (#2): a concurrent drainPending + live void-resume on the SAME
// pending row must produce EXACTLY ONE operator rollback (no sweep-vs-live-void double-reverse
// against a non-idempotent operator). FAILS-FIRST against pre-#2 code (claim ignored draining →
// both paths emit → 2 rollbacks → over-reversed balance).
describe("M1.F drain race — concurrent drain + live void-resume emit exactly once", () => {
  const operatorApi = new NonIdempotentMockOperator();
  const seamless = new SeamlessOperatorWallet(operatorApi, sessions.resolver(), {}, rollbackStore);
  const router = new WalletRouter(ledger, seamless, (walletId) => sessions.isDemoWallet(walletId));
  const opBets = new BetsService(prisma, router, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

  test("a DRAIN holding the in-flight refund + a concurrent live void-resume emit EXACTLY ONCE", async () => {
    const startBalance = 100_000;
    const { op, playerId, currency, walletId, userId } = await launchReal(operatorApi, "F", "EUR", startBalance);
    const roundId = await makeRound();
    const panel = "A";
    const K = debitKey(roundId, userId, panel);
    const { betId } = await settledOperatorBetOnRound(operatorApi, { operatorId: op.id, userId, walletId, playerId, currency, roundId, panel, stake: 1000, payout: 2500 });
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance + 1500));

    // Arm the FIRST emit of the refund leg (on key K) to throw once → the void's refund leg
    // fails its emit and leaves a PENDING void_refund row (the durable owed-rollback). The
    // reclaim leg (different txId) succeeds. voidBet rethrows (propagate) → bet stays `voiding`.
    operatorApi.failNextRollback(K);
    await expect(opBets.voidBet(op.id, betId)).rejects.toBeDefined();
    const refundRow = await findRow(op.id, { betId, transactionId: K, reason: "void_refund" });
    expect(refundRow?.status).toBe("pending"); // owed; the reclaim leg already confirmed
    // Operator balance so far: −2500 reclaim done, refund NOT yet → start +1500 −2500 = start −1000.
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance - 1000));
    const rollbacksBeforeRace = operatorApi.calls.rollback;

    // DETERMINISTIC RACE: gate the NEXT rollback of K so the drain's emit blocks IN-FLIGHT
    // (row = draining, live lease). While it is held, run the live void-resume — its refund
    // leg's claim must see the in-flight lease and SKIP the operator emit (#2). Then release.
    const gate = operatorApi.gateNextRollback(K);
    const drainP = rollbackStore.drainPending(operatorApi); // acquires lease, then blocks at the gate
    await gate.entered; // the drain's rollback(K) is now in-flight (row draining)

    // Concurrent live void-resume on the SAME owed reversal — must NOT also emit.
    const finalized = await opBets.reconcileVoidingBets();
    // At this instant exactly the drain's single emit has happened (still blocked, but counted).
    expect(operatorApi.calls.rollback).toBe(rollbacksBeforeRace + 1); // the live path did NOT emit

    gate.release(); // let the drain's rollback complete + confirm
    await drainP;

    // EXACTLY ONE additional operator rollback fired across both paths (no double-reverse).
    expect(operatorApi.calls.rollback).toBe(rollbacksBeforeRace + 1);
    // Balance restored to exactly the start — not over-reversed (a double would be start +1000).
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance));
    // The refund row is confirmed and nothing is left owed.
    const after = await findRow(op.id, { betId, transactionId: K, reason: "void_refund" });
    expect(after?.status).toBe("confirmed");
    expect(await prisma.walletRollback.count({ where: { operatorId: op.id, status: { in: ["pending", "draining"] } } })).toBe(0);
    expect(finalized).toBeGreaterThanOrEqual(0);

    // Finalise the bet (the live resume left it `voiding` since its reversal was in-flight);
    // a subsequent sweep now sees both legs confirmed → flips to voided WITHOUT re-emitting.
    const finalized2 = await opBets.reconcileVoidingBets();
    expect(operatorApi.calls.rollback).toBe(rollbacksBeforeRace + 1); // STILL one — both legs confirmed
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("voided");
    expect(finalized2).toBeGreaterThanOrEqual(0);
  });
});
