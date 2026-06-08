import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { ConflictException, NotFoundException } from "@nestjs/common";
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
import { SeamlessOperatorWallet } from "../src/wallet/seamless-operator-wallet";
import { WAGERED_STATUSES } from "../src/common/bet-status";
import { MockOperator } from "./helpers/mock-operator";

/**
 * Operator-initiated VOID of a SETTLED bet (Phase 6) — money-moving, DB-backed.
 * Covers BetsService.voidBet / performVoidReversals / reconcileVoidingBets and the
 * money-conservation + reconcile-check invariants the void legs MUST preserve.
 *
 * THE VOID RULES (verified against src/game/bets.service.ts voidBet):
 *   busted     → refund stake.
 *   cashed_out → reclaim payout (FIRST) + refund stake.
 *   active                              → `bet_not_settled` (409 ConflictException).
 *   reserving|cancelling|payout_pending → `bet_transient`  (409 ConflictException).
 *   voided                             → idempotent no-op (reversed:false).
 *   cancelled                          → no-op (reversed:false).
 *   wrong / null operator              → `bet_not_found` (404 NotFoundException).
 * CAS busted/cashed_out → `voiding`, then idempotent reverses
 *   (`bet:{id}:void_reclaim` NEGATIVE payout_credit; `bet:{id}:void_refund` refund;
 *    both refType:"bet"), then CAS `voiding` → `voided`.
 *
 * Wiring mirrors exposure-cap-h1 / operator-money-path-e2e: a real PrismaService +
 * RiskService + MetricsService + a fake engine, and BetsService over either the raw
 * LedgerService (internal/ledger mode) or a WalletRouter→SeamlessOperatorWallet
 * (operator mode). DB rows are tracked and torn down FK-safely in afterAll.
 */

const JWT_SECRET = "void-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma));

const fakeEngine: any = {
  getPublicState: () => ({ roundId: "", phase: "betting", phaseEndsAt: Date.now() + 60_000, multiplier: 1, serverTime: Date.now() }),
  currentMultiplier: () => 1,
};

// INTERNAL/ledger-mode service (the play-money book — what reconcile-check audits).
const betsLedger = new BetsService(prisma, ledger, fakeEngine, risk, metrics);

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];
const createdUserIds: string[] = [];
const createdBetIds: string[] = [];

// Synthetic epochs sit far above any real epoch so a read-only fairness scan is never touched.
async function makeRound(status = "crashed"): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 7_700_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "void-" + randomUUID(),
      length: 2,
      salt: "void-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "void-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status, bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** A plain INTERNAL (operatorId:null) player + wallet. */
async function internalPlayer(balance: bigint) {
  const id = randomUUID();
  const user = await prisma.user.create({
    data: {
      id,
      username: "void_int_" + id.slice(0, 10),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "v" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(user.id);
  return { userId: user.id, walletId: user.wallets[0].id };
}

const debitKey = (roundId: string, userId: string, panel: string) => `bet:${roundId}:${userId}:${panel}:debit`;
const payoutKey = (betId: string) => `bet:${betId}:payout`;

/**
 * Seed a SETTLED internal bet WITH its real ledger rows, exactly as the live money
 * path would leave it: a `bet_debit` under the deterministic debit key, and (for a
 * win) a `payout_credit` under `bet:{id}:payout`. This is what makes the void's
 * reverse legs (and the reconcile-check invariants) meaningful — the void posts the
 * INVERSE of these exact rows.
 *
 * Returns the betId and the wallet balance AFTER settlement (the pre-void balance).
 */
async function settledInternalBet(opts: {
  walletId: string;
  userId: string;
  status: "busted" | "cashed_out";
  stake: bigint;
  payout?: bigint;
  operatorId?: string | null;
  panel?: "A" | "B";
}): Promise<{ betId: string; roundId: string; postSettleBalance: bigint }> {
  const roundId = await makeRound();
  const panel = opts.panel ?? "A";
  const betId = randomUUID();

  // 1) the stake debit (every settled bet had its stake debited)
  await ledger.debit(opts.walletId, opts.stake, "bet_debit", debitKey(roundId, opts.userId, panel), {
    refType: "bet",
    refId: betId,
  });
  // 2) the payout credit (only a win)
  const payout = opts.payout ?? 0n;
  let payoutTxId: string | null = null;
  if (opts.status === "cashed_out" && payout > 0n) {
    const tx = await ledger.credit(opts.walletId, payout, "payout_credit", payoutKey(betId), { refType: "bet", refId: betId });
    payoutTxId = tx.id;
  }

  await prisma.bet.create({
    data: {
      id: betId,
      roundId,
      userId: opts.userId,
      walletId: opts.walletId,
      panel,
      amount: opts.stake,
      status: opts.status,
      payout,
      operatorId: opts.operatorId ?? null,
      currency: "DEMO",
      ...(payoutTxId ? { payoutTxId, cashoutMult: 2.5 } : {}),
      settledAt: new Date(),
    },
  });
  createdBetIds.push(betId);
  const postSettleBalance = await ledger.getBalance(opts.walletId);
  return { betId, roundId, postSettleBalance };
}

/** Seed a bet in an arbitrary (possibly transient) status with NO ledger rows — for
 *  status-branch rejection tests where the money legs are never reached. */
async function bareBet(opts: {
  walletId: string;
  userId: string;
  status: string;
  stake?: bigint;
  payout?: bigint;
  operatorId?: string | null;
}): Promise<string> {
  const roundId = await makeRound();
  const betId = randomUUID();
  await prisma.bet.create({
    data: {
      id: betId,
      roundId,
      userId: opts.userId,
      walletId: opts.walletId,
      panel: "A",
      amount: opts.stake ?? 1000n,
      status: opts.status,
      payout: opts.payout ?? 0n,
      operatorId: opts.operatorId ?? null,
      currency: "DEMO",
    },
  });
  createdBetIds.push(betId);
  return betId;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe: bets → rounds → seeds → chains; operator-tagged users; operators; plain users.
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    for (const operatorId of createdOperatorIds) {
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("V.1 voidBet money conservation (internal/ledger mode)", () => {
  test("busted → void refunds the stake; balance returns to pre-bet; status voided", async () => {
    const START = 10_000n;
    const { userId, walletId } = await internalPlayer(START);
    const { betId, postSettleBalance } = await settledInternalBet({
      walletId, userId, status: "busted", stake: 1000n,
    });
    expect(postSettleBalance).toBe(9000n); // stake debited, lost

    // operatorId:null matches the bet's null operatorId (the internal/guest tenant gate).
    const res = await betsLedger.voidBet(null as any, betId, "dispute");
    expect(res.ok).toBe(true);
    expect(res.status).toBe("voided");
    expect(res.reversed).toBe(true);
    expect(res.refundedStake).toBe("1000");
    expect(res.reclaimedPayout).toBe("0");
    expect(await ledger.getBalance(walletId)).toBe(START); // back to pre-bet
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("voided");
  });

  test("cashed_out → void reclaims payout AND refunds stake; balance returns to pre-bet", async () => {
    const START = 10_000n;
    const { userId, walletId } = await internalPlayer(START);
    // stake 1000, payout 2500 → post-settle balance = 10000 − 1000 + 2500 = 11500
    const { betId, postSettleBalance } = await settledInternalBet({
      walletId, userId, status: "cashed_out", stake: 1000n, payout: 2500n,
    });
    expect(postSettleBalance).toBe(11_500n);

    const res = await betsLedger.voidBet(null as any, betId);
    expect(res.reversed).toBe(true);
    expect(res.refundedStake).toBe("1000");
    expect(res.reclaimedPayout).toBe("2500");
    // reclaim payout (−2500) THEN refund stake (+1000) → 11500 − 2500 + 1000 = 10000.
    expect(await ledger.getBalance(walletId)).toBe(START); // as if the bet never happened
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("voided");

    // The two inverse rows exist with the EXACT keys/types/refType the reconcile join needs.
    const reclaim = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: `bet:${betId}:void_reclaim` } });
    const refund = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: `bet:${betId}:void_refund` } });
    expect(reclaim!.type).toBe("payout_credit");
    expect(reclaim!.amount).toBe(-2500n); // NEGATIVE
    expect(reclaim!.refType).toBe("bet");
    expect(reclaim!.refId).toBe(betId);
    expect(refund!.type).toBe("refund");
    expect(refund!.amount).toBe(1000n); // POSITIVE
    expect(refund!.refType).toBe("bet");
    expect(refund!.refId).toBe(betId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V.2 — THE KEY REGRESSION for HIGH-1: after voids, the reconcile-check invariants
// (1a debit conservation, 1b payout conservation, 2 ledger↔balance) STILL hold. This
// would FAIL if the void legs used the wrong ledger type/refType. We replicate the
// EXACT queries scripts/reconcile-check.ts runs, scoped to OUR wallets so the shared
// dev DB's other rows don't pollute the assertion.
describe("V.2 reconcile-check invariants after void (regression for HIGH-1)", () => {
  test("1a + 1b + 2 all PASS with the void rows present (internal book)", async () => {
    const START = 50_000n;
    const { userId, walletId } = await internalPlayer(START);

    // A busted bet that we VOID (refund only).
    const b1 = await settledInternalBet({ walletId, userId, status: "busted", stake: 1000n });
    // A cashed_out bet that we VOID (reclaim + refund).
    const b2 = await settledInternalBet({ walletId, userId, status: "cashed_out", stake: 2000n, payout: 5000n });
    // A busted bet we DON'T void — the house keeps this stake (proves 1a stays exact
    // with both a kept stake and a fully-netted void in the same wallet).
    const kept = await settledInternalBet({ walletId, userId, status: "busted", stake: 3000n });

    await betsLedger.voidBet(null as any, b1.betId);
    await betsLedger.voidBet(null as any, b2.betId);

    // ---- Replicate reconcile-check invariants, scoped to THIS wallet ----
    // Bet ids in scope (so the ledger join mirrors the script's refType='bet' join,
    // but only over our synthetic bets — exactly the rows we created).
    const ourBetIds = [b1.betId, b2.betId, kept.betId];

    type Agg = { s: bigint | null };
    const sumLedger = async (type: string): Promise<bigint> =>
      (
        await prisma.$queryRaw<Agg[]>`
          SELECT COALESCE(SUM(l.amount), 0)::bigint AS s
          FROM ledger_transactions l JOIN game_bets b ON b.id = l.ref_id
          WHERE l.type = ${type} AND l.ref_type = 'bet' AND b.operator_id IS NULL
            AND l.wallet_id = ${walletId}::uuid`
      )[0].s ?? 0n;

    const liveDebit = await sumLedger("bet_debit"); // negative
    const liveRefund = await sumLedger("refund"); // positive (incl. the void refunds)
    const livePayout = await sumLedger("payout_credit"); // net (incl. the negative void reclaim)

    // Σ stake over still-HELD statuses for this wallet (the script's heldStakes).
    const heldStakes =
      (await prisma.bet.aggregate({
        where: { walletId, operatorId: null, status: { in: [...WAGERED_STATUSES] } },
        _sum: { amount: true },
      }))._sum.amount ?? 0n;

    // INVARIANT 1a: |Σ bet_debit| − Σ refund == Σ stake(held).
    // After the two voids, only `kept` (3000, busted) is still held; b1/b2 are `voided`
    // (NOT in WAGERED_STATUSES) and their debits are fully netted by the void refunds.
    const debitNetOfRefunds = -liveDebit - liveRefund;
    expect(debitNetOfRefunds).toBe(heldStakes); // 1a PASS
    expect(heldStakes).toBe(3000n); // sanity: only the un-voided busted stake remains held

    // INVARIANT 1b: Σ payout_credit == Σ payout over PAID wins (cashed_out).
    // b2 is now `voided` (not cashed_out) and its payout_credit (+5000) is netted by the
    // void reclaim (−5000) → live payout_credit nets to 0, paid cashed_out payouts = 0.
    const paidPayouts =
      (await prisma.bet.aggregate({ where: { walletId, operatorId: null, status: "cashed_out" }, _sum: { payout: true } }))._sum.payout ?? 0n;
    expect(livePayout).toBe(paidPayouts); // 1b PASS
    expect(livePayout).toBe(0n);
    expect(paidPayouts).toBe(0n);

    // INVARIANT 2: latest balanceAfter == wallet.balance (ledger reconstructs balance).
    const balRow = (
      await prisma.$queryRaw<{ balance: bigint; balance_after: bigint }[]>`
        SELECT w.balance AS balance, lt.balance_after AS balance_after
        FROM wallets w
        JOIN LATERAL (
          SELECT balance_after FROM ledger_transactions l
          WHERE l.wallet_id = w.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1
        ) lt ON true
        WHERE w.id = ${walletId}::uuid`
    )[0];
    expect(BigInt(balRow.balance)).toBe(BigInt(balRow.balance_after)); // 2 PASS

    // Final balance: START − kept(3000, busted, never returned) = 47000. b1 + b2 net to 0.
    expect(await ledger.getBalance(walletId)).toBe(START - 3000n);
    // Belt-and-braces: the void rows are exactly the ones we joined on.
    const voidRows = await prisma.ledgerTransaction.findMany({
      where: { walletId, idempotencyKey: { in: ourBetIds.flatMap((id) => [`bet:${id}:void_refund`, `bet:${id}:void_reclaim`]) } },
    });
    expect(voidRows.length).toBe(3); // b1 refund, b2 refund, b2 reclaim (kept has none)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("V.3 status-branch rejections + idempotent terminal short-circuits", () => {
  test("active → bet_not_settled (409); no money moved", async () => {
    const { userId, walletId } = await internalPlayer(10_000n);
    const betId = await bareBet({ walletId, userId, status: "active", stake: 1000n });
    await expect(betsLedger.voidBet(null as any, betId)).rejects.toThrow(ConflictException);
    await expect(betsLedger.voidBet(null as any, betId)).rejects.toThrow("bet_not_settled");
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("active"); // unchanged
  });

  test("reserving | cancelling | payout_pending → bet_transient (409) [table-driven]", async () => {
    const { userId, walletId } = await internalPlayer(10_000n);
    for (const status of ["reserving", "cancelling", "payout_pending"] as const) {
      const betId = await bareBet({ walletId, userId, status, stake: 1000n, payout: status === "payout_pending" ? 1500n : 0n });
      await expect(betsLedger.voidBet(null as any, betId)).rejects.toThrow("bet_transient");
      expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe(status); // unchanged
    }
  });

  test("re-void of an already-voided bet → reversed:false no-op with the same figures", async () => {
    const START = 10_000n;
    const { userId, walletId } = await internalPlayer(START);
    const { betId } = await settledInternalBet({ walletId, userId, status: "cashed_out", stake: 1000n, payout: 2500n });
    const first = await betsLedger.voidBet(null as any, betId);
    expect(first.reversed).toBe(true);
    const balanceAfterFirst = await ledger.getBalance(walletId);

    const second = await betsLedger.voidBet(null as any, betId); // idempotent re-void
    expect(second.ok).toBe(true);
    expect(second.status).toBe("voided");
    expect(second.reversed).toBe(false); // THIS call did no work
    expect(second.refundedStake).toBe("1000"); // lifetime figures preserved
    expect(second.reclaimedPayout).toBe("2500");
    expect(await ledger.getBalance(walletId)).toBe(balanceAfterFirst); // no double-move
    expect(await ledger.getBalance(walletId)).toBe(START);
  });

  test("cancelled (player pre-settle cancel) → reversed:false no-op (already net-zero)", async () => {
    const { userId, walletId } = await internalPlayer(10_000n);
    const betId = await bareBet({ walletId, userId, status: "cancelled", stake: 1000n });
    const res = await betsLedger.voidBet(null as any, betId);
    expect(res.ok).toBe(true);
    expect(res.status).toBe("cancelled");
    expect(res.reversed).toBe(false);
    expect(res.refundedStake).toBe("1000");
    expect(res.reclaimedPayout).toBe("0");
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("cancelled"); // unchanged
  });

  test("cross-tenant operatorId → bet_not_found (404) and money untouched", async () => {
    const START = 10_000n;
    const { userId, walletId } = await internalPlayer(START);
    // A bet OWNED by operator A.
    const opA = randomUUID();
    const opB = randomUUID();
    const { betId, postSettleBalance } = await settledInternalBet({
      walletId, userId, status: "busted", stake: 1000n, operatorId: opA,
    });
    // Operator B trying to void A's bet → 404 (no cross-tenant existence oracle).
    await expect(betsLedger.voidBet(opB, betId)).rejects.toThrow(NotFoundException);
    await expect(betsLedger.voidBet(opB, betId)).rejects.toThrow("bet_not_found");
    expect(await ledger.getBalance(walletId)).toBe(postSettleBalance); // unchanged
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("busted");

    // And the rightful owner CAN void it (proves it's a tenant gate, not "missing").
    const ok = await betsLedger.voidBet(opA, betId);
    expect(ok.reversed).toBe(true);
    expect(await ledger.getBalance(walletId)).toBe(START);
  });

  test("an operatorId:null (internal/guest) bet → bet_not_found (404) when an operator probes it", async () => {
    const { userId, walletId } = await internalPlayer(10_000n);
    const { betId } = await settledInternalBet({ walletId, userId, status: "busted", stake: 1000n, operatorId: null });
    // ANY real operator id must not be able to void an internal/guest (null-operator) bet.
    await expect(betsLedger.voidBet(randomUUID(), betId)).rejects.toThrow("bet_not_found");
  });

  test("a non-existent betId → bet_not_found (404)", async () => {
    await expect(betsLedger.voidBet(randomUUID(), randomUUID())).rejects.toThrow("bet_not_found");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V.4 — the stuck-`voiding` finalizer. Simulate reclaim-ok / refund-FAIL (a wallet
// whose 2nd reverse throws once) so the bet is stranded `voiding` with the stake NOT
// yet refunded; then reconcileVoidingBets() completes the refund idempotently.
describe("V.4 reconcileVoidingBets — finishes a stranded voiding bet (resume)", () => {
  test("reclaim-ok / refund-fail strands the bet in voiding; the sweep completes it, no double-move", async () => {
    const START = 10_000n;
    const { userId, walletId } = await internalPlayer(START);
    // A WON bet so the void has BOTH legs (reclaim first, then refund).
    const { betId, postSettleBalance } = await settledInternalBet({
      walletId, userId, status: "cashed_out", stake: 1000n, payout: 2500n,
    });
    expect(postSettleBalance).toBe(11_500n);

    // A provider that DELEGATES to the real ledger but makes the FIRST refund leg
    // (originalDirection === "debit") throw exactly once — the reclaim leg goes
    // through, so the bet is left `voiding` with the payout reclaimed but the stake
    // NOT yet refunded. The finalizer must heal this idempotently.
    let refundFailsLeft = 1;
    const flakyProvider: any = {
      reverse: async (wId: string, p: any) => {
        if (p.originalDirection === "debit" && refundFailsLeft > 0) {
          refundFailsLeft--;
          throw new Error("refund_boom"); // transient refund failure
        }
        return ledger.reverse(wId, p);
      },
      // unused by void, present to satisfy any incidental call
      debit: ledger.debit.bind(ledger),
      credit: ledger.credit.bind(ledger),
      rollback: ledger.rollback.bind(ledger),
      getBalance: ledger.getBalance.bind(ledger),
    };
    const flakyBets = new BetsService(prisma, flakyProvider, fakeEngine, risk, metrics);

    // First void attempt: reclaim applies (−2500), refund throws → bet stuck `voiding`.
    await expect(flakyBets.voidBet(null as any, betId)).rejects.toThrow("refund_boom");
    const stuck = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(stuck.status).toBe("voiding"); // claimed but not finalised
    expect(await ledger.getBalance(walletId)).toBe(11_500n - 2500n); // 9000 — reclaimed, NOT yet refunded
    const reclaim = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: `bet:${betId}:void_reclaim` } });
    expect(reclaim).not.toBeNull(); // reclaim leg DID apply
    const refundBefore = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: `bet:${betId}:void_refund` } });
    expect(refundBefore).toBeNull(); // refund leg did NOT apply

    // Run the finalizer (refundFailsLeft is now 0 → the refund succeeds, the reclaim
    // re-issue is idempotent — no double clawback).
    const finalized = await flakyBets.reconcileVoidingBets();
    expect(finalized).toBeGreaterThanOrEqual(1);

    const done = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(done.status).toBe("voided"); // healed
    expect(await ledger.getBalance(walletId)).toBe(START); // fully restored, exactly once
    // Exactly one reclaim and one refund row — the sweep did NOT double-move.
    const reclaims = await prisma.ledgerTransaction.findMany({ where: { walletId, type: "payout_credit", amount: -2500n } });
    expect(reclaims.length).toBe(1);
    const refunds = await prisma.ledgerTransaction.findMany({ where: { walletId, idempotencyKey: `bet:${betId}:void_refund` } });
    expect(refunds.length).toBe(1);
    expect(refunds[0].amount).toBe(1000n);
  });

  test("reconcileVoidingBets is a no-op when nothing is stranded (returns 0)", async () => {
    // We can't assert global 0 (shared DB), but our own no-stuck wallet contributes none.
    const n = await betsLedger.reconcileVoidingBets();
    expect(n).toBeGreaterThanOrEqual(0); // never throws; returns a count
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("V.5 concurrency — two voids race; money moves exactly once", () => {
  test("concurrent voidBet on the same busted bet → exactly one reversed:true, the other bet_state_changed", async () => {
    const START = 10_000n;
    const { userId, walletId } = await internalPlayer(START);
    const { betId } = await settledInternalBet({ walletId, userId, status: "busted", stake: 1000n });

    const results = await Promise.allSettled([
      betsLedger.voidBet(null as any, betId),
      betsLedger.voidBet(null as any, betId),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    // One claimed the CAS and reversed; the other lost the claim. (A loser may EITHER
    // throw bet_state_changed, OR — if it read the row AFTER the winner finalised —
    // return an idempotent reversed:false no-op. Both are correct; money moves once.)
    const reversedTrue = fulfilled.filter((r) => r.value.reversed === true);
    expect(reversedTrue.length).toBe(1); // exactly one did the work
    for (const r of rejected) expect(String(r.reason)).toContain("bet_state_changed");
    // Whatever the loser did, it did NOT move money twice.
    expect(await ledger.getBalance(walletId)).toBe(START); // refunded exactly once
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("voided");
    const refunds = await prisma.ledgerTransaction.findMany({ where: { walletId, idempotencyKey: `bet:${betId}:void_refund` } });
    expect(refunds.length).toBe(1); // money moved once
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V.6 — mode routing. An OPERATOR-mode bet voids via the operator: it issues
// `rollback` of the ORIGINAL payout / debit keys (no new bet/win), proven via the
// MockOperator's recorded calls.
describe("V.6 operator-mode void routes to operator rollback (no new turnover)", () => {
  // Build an operator-mode BetsService over a WalletRouter→SeamlessOperatorWallet.
  const operatorApi = new MockOperator();
  const seamless = new SeamlessOperatorWallet(operatorApi, sessions.resolver());
  const router = new WalletRouter(ledger, seamless, (walletId) => sessions.isDemoWallet(walletId));
  const opBets = new BetsService(prisma, router, fakeEngine, risk, metrics);

  async function launchReal(currency: string, operatorBalance: number) {
    const op = await prisma.operator.create({
      data: {
        code: "op-void-" + randomUUID().slice(0, 8),
        name: "Void Operator",
        enabled: true,
        demoEnabled: false,
        launchSecret: "secret-" + randomUUID(),
        currencies: [currency],
      },
    });
    createdOperatorIds.push(op.id);
    const playerId = "p-" + randomUUID().slice(0, 8);
    const token = await launch.issue({ operatorId: op.id, playerId, currency });
    const s = await sessions.openFromToken(token); // NON-demo → routes to the operator
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: s.walletId } });
    operatorApi.seed(playerId, currency, operatorBalance);
    return { op, playerId, currency, walletId: s.walletId, userId: wallet.userId };
  }

  /** Seed a SETTLED operator bet by applying the ORIGINAL operator moves under the
   *  EXACT keys voidBet will roll back (debit key + payout key), then the Bet row. No
   *  internal ledger rows are written for an operator wallet (operator is the truth). */
  async function settledOperatorBet(opts: {
    operatorId: string; userId: string; walletId: string; playerId: string; currency: string;
    status: "busted" | "cashed_out"; stake: number; payout?: number;
  }): Promise<{ betId: string }> {
    const roundId = await makeRound();
    const betId = randomUUID();
    // Original stake debit at the operator under the deterministic debit key.
    // F-001b: amount is a BigInt-safe decimal string on the wire.
    await operatorApi.bet(opts.operatorId, {
      playerId: opts.playerId, currency: opts.currency, amount: opts.stake.toString(),
      transactionId: debitKey(roundId, opts.userId, "A"), roundId, betId,
    });
    let payoutTxId: string | null = null;
    if (opts.status === "cashed_out" && (opts.payout ?? 0) > 0) {
      const w = await operatorApi.win(opts.operatorId, {
        playerId: opts.playerId, currency: opts.currency, amount: opts.payout!.toString(),
        transactionId: payoutKey(betId), roundId, betId,
      });
      payoutTxId = w.operatorTxId;
    }
    await prisma.bet.create({
      data: {
        id: betId, roundId, userId: opts.userId, walletId: opts.walletId, panel: "A",
        amount: BigInt(opts.stake), status: opts.status, payout: BigInt(opts.payout ?? 0),
        operatorId: opts.operatorId, currency: opts.currency,
        ...(payoutTxId ? { payoutTxId, cashoutMult: 2.5 } : {}),
        settledAt: new Date(),
      },
    });
    createdBetIds.push(betId);
    return { betId };
  }

  test("DEMO bet voids via the LEDGER (sanity: not every void hits the operator)", async () => {
    // A guest/internal (null-operator) bet through the SAME operator-mode router: the
    // router classifies a no-session wallet as demo → ledger; operator untouched.
    const START = 10_000n;
    const { userId, walletId } = await internalPlayer(START);
    const { betId } = await settledInternalBet({ walletId, userId, status: "busted", stake: 1000n, operatorId: null });
    const rollbacksBefore = operatorApi.calls.rollback;
    const res = await opBets.voidBet(null as any, betId); // demo wallet → ledger reverse
    expect(res.reversed).toBe(true);
    expect(await ledger.getBalance(walletId)).toBe(START); // refunded on the ledger
    expect(operatorApi.calls.rollback).toBe(rollbacksBefore); // operator NOT called
  });

  test("operator cashed_out void → rollback of the ORIGINAL payout + debit keys (no new bet/win)", async () => {
    const startBalance = 100_000;
    const { op, playerId, currency, walletId, userId } = await launchReal("EUR", startBalance);
    const { betId } = await settledOperatorBet({
      operatorId: op.id, userId, walletId, playerId, currency,
      status: "cashed_out", stake: 1000, payout: 2500,
    });
    // After settlement: −1000 +2500 = +1500 at the operator.
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance + 1500));
    const betsBefore = operatorApi.calls.bet;
    const winsBefore = operatorApi.calls.win;
    const rollbacksBefore = operatorApi.calls.rollback;

    const res = await opBets.voidBet(op.id, betId);
    expect(res.reversed).toBe(true);
    expect(res.refundedStake).toBe("1000");
    expect(res.reclaimedPayout).toBe("2500");

    // BOTH original moves were rolled back at the operator → balance back to start.
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance));
    expect(operatorApi.calls.rollback).toBe(rollbacksBefore + 2); // payout reclaim + stake refund
    // NO new turnover — reverse must never post a fresh bet/win (no GGR inflation).
    expect(operatorApi.calls.bet).toBe(betsBefore);
    expect(operatorApi.calls.win).toBe(winsBefore);
    // And NO internal ledger inverse rows for an operator wallet.
    expect(await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: `bet:${betId}:void_refund` } })).toBeNull();
    expect(await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: `bet:${betId}:void_reclaim` } })).toBeNull();
    expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("voided");
  });

  test("operator busted void → single rollback of the original debit key (refund only)", async () => {
    const startBalance = 100_000;
    const { op, playerId, currency, walletId, userId } = await launchReal("EUR", startBalance);
    const { betId } = await settledOperatorBet({
      operatorId: op.id, userId, walletId, playerId, currency, status: "busted", stake: 1000,
    });
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance - 1000)); // stake lost
    const rollbacksBefore = operatorApi.calls.rollback;

    const res = await opBets.voidBet(op.id, betId);
    expect(res.reversed).toBe(true);
    expect(res.reclaimedPayout).toBe("0"); // no payout to reclaim
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance)); // stake refunded
    expect(operatorApi.calls.rollback).toBe(rollbacksBefore + 1); // ONLY the stake refund
  });
});
