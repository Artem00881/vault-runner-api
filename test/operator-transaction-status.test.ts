import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { ReportingService } from "../src/operator/reporting.service";
import { parseTransactionQuery } from "../src/operator/reporting-query";

/**
 * Phase 6 — operator TRANSACTION-STATUS lookup, DB-backed service tests.
 *
 * `transactionStatus(operatorId, q)` resolves ONE money-move (by our betId, or by the
 * idempotency-key transactionId we sent on a wallet call) to its bet's disposition.
 * The invariants here are certification + money-path evidence:
 *  - TENANT ISOLATION (fail-first): a bet of operator B, or an internal/guest bet
 *    (operatorId=null), or a nonexistent id → 404 transaction_not_found for operator A.
 *    NO cross-tenant existence oracle (identical 404 either way).
 *  - RESOLUTION: the SAME bet is reachable by betId, by its debit transactionId
 *    (compound roundId_userId_panel key), by its payout transactionId, and by a
 *    restart_refund transactionId.
 *  - STATE MAPPING: the explicit debit/refund/payout dispositions on REAL rows match
 *    the pure mappers for representative statuses (a transient status is "pending",
 *    never an ambiguous boolean).
 *  - NULL handling: null currency (decimals fallback 2), null cashoutMult, null
 *    settledAt never throw.
 *  - QUERY ECHO: the response reflects the caller's INPUT (betId form sets query.betId
 *    + null transactionId; a transactionId form sets query.transactionId + null betId).
 *
 * Mirrors test/operator-reporting.test.ts: real Operator + GameSession + hand-crafted
 * Bet rows on their own rounds; FK-safe cleanup in afterAll.
 */

const prisma = new PrismaService();
const reporting = new ReportingService(prisma);

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];
const createdUserIds: string[] = [];

async function makeRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 5_400_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "txs-" + randomUUID(),
      length: 2,
      salt: "txs-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "txs-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status: "crashed", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function freshOperator(currencies: string[] = ["EUR"]) {
  const op = await prisma.operator.create({
    data: {
      code: "op-txs-" + randomUUID().slice(0, 8),
      name: "TxStatus Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: currencies.map((c) => c.toUpperCase()),
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

/** Real player journal wallet + a GameSession linking walletId → playerId, so the
 *  lookup can resolve the operator-side playerId. */
async function makePlayer(operatorId: string, playerId: string, currency: string) {
  const user = await prisma.user.create({
    data: { username: `txs:${operatorId}:${playerId}:${currency}:${randomUUID().slice(0, 6)}`, isGuest: false },
  });
  createdUserIds.push(user.id);
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, currency: currency.toUpperCase(), balance: 0n },
  });
  await prisma.gameSession.create({
    data: {
      operatorId,
      playerId,
      currency: currency.toUpperCase(),
      walletId: wallet.id,
      launchJti: "jti-" + randomUUID(),
    },
  });
  return { userId: user.id, walletId: wallet.id, playerId };
}

interface SeedBet {
  operatorId: string | null; // null = internal/guest (excluded from operator reports)
  amount: bigint;
  status: string;
  payout?: bigint;
  panel?: "A" | "B";
  currency?: string | null; // undefined → "EUR"; an unseeded code (e.g. "XYZ") exercises the decimals fallback; null is rejected by the NOT NULL constraint (F-084)
  cashoutMult?: number | null;
  demo?: boolean;
  debitTxId?: string | null;
  payoutTxId?: string | null;
  settledAt?: Date | null;
}

/** Insert a hand-crafted Bet on its own fresh round (so the (round,user,panel) unique
 *  never collides). Returns the ids needed to build any transactionId form. */
async function seedBet(
  walletId: string,
  userId: string,
  o: SeedBet,
): Promise<{ betId: string; roundId: string; userId: string; panel: "A" | "B" }> {
  const roundId = await makeRound();
  const betId = randomUUID();
  const panel = o.panel ?? "A";
  await prisma.bet.create({
    data: {
      id: betId,
      roundId,
      userId,
      walletId,
      panel,
      amount: o.amount,
      status: o.status,
      payout: o.payout ?? 0n,
      demo: o.demo ?? false,
      operatorId: o.operatorId,
      currency: o.currency === undefined ? "EUR" : o.currency,
      ...(o.cashoutMult !== undefined && o.cashoutMult !== null ? { cashoutMult: o.cashoutMult } : {}),
      ...(o.debitTxId !== undefined ? { debitTxId: o.debitTxId } : {}),
      ...(o.payoutTxId !== undefined ? { payoutTxId: o.payoutTxId } : {}),
      ...(o.settledAt !== undefined && o.settledAt !== null ? { settledAt: o.settledAt } : {}),
    },
  });
  return { betId, roundId, userId, panel };
}

const debitTxIdOf = (roundId: string, userId: string, panel: "A" | "B") => `bet:${roundId}:${userId}:${panel}:debit`;
const payoutTxIdOf = (betId: string) => `bet:${betId}:payout`;
const refundTxIdOf = (betId: string) => `bet:${betId}:refund`;
const restartRefundTxIdOf = (betId: string) => `bet:${betId}:restart_refund`;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe: bets → rounds → seeds → chains; sessions cascade with operator; wallets/
  // ledger cascade with the user. Never fail the suite on cleanup.
  try {
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("TXS.1 tenant isolation (fail-first) — 404 transaction_not_found, no cross-tenant oracle", () => {
  test("a bet under operator B → 404 for operator A (by betId AND by every transactionId form)", async () => {
    const opA = await freshOperator(["EUR"]);
    const opB = await freshOperator(["EUR"]);
    const b = await makePlayer(opB.id, "b-player", "EUR");
    const bet = await seedBet(b.walletId, b.userId, { operatorId: opB.id, amount: 1000n, status: "active" });

    // betId
    await expect(reporting.transactionStatus(opA.id, parseTransactionQuery({ betId: bet.betId }))).rejects.toThrow(
      NotFoundException,
    );
    // debit transactionId (compound key still resolves the row, but tenant gate 404s)
    await expect(
      reporting.transactionStatus(
        opA.id,
        parseTransactionQuery({ transactionId: debitTxIdOf(bet.roundId, bet.userId, bet.panel) }),
      ),
    ).rejects.toThrow(NotFoundException);
    // payout transactionId
    await expect(
      reporting.transactionStatus(opA.id, parseTransactionQuery({ transactionId: payoutTxIdOf(bet.betId) })),
    ).rejects.toThrow(NotFoundException);

    // The SAME bet IS visible to its owner B (proves it exists — the 404 to A is the gate).
    const okB = await reporting.transactionStatus(opB.id, parseTransactionQuery({ betId: bet.betId }));
    expect(okB.betId).toBe(bet.betId);
    expect(okB.operatorId).toBe(opB.id);
  });

  test("an internal/guest bet (operatorId=null) → 404 for an operator", async () => {
    const opA = await freshOperator(["EUR"]);
    // The wallet/session can belong to anyone; the bet carries operatorId=null (internal play).
    const p = await makePlayer(opA.id, "internal-player", "EUR");
    const bet = await seedBet(p.walletId, p.userId, { operatorId: null, amount: 500n, status: "busted" });
    await expect(reporting.transactionStatus(opA.id, parseTransactionQuery({ betId: bet.betId }))).rejects.toThrow(
      NotFoundException,
    );
  });

  test("a nonexistent betId → 404", async () => {
    const opA = await freshOperator(["EUR"]);
    await expect(reporting.transactionStatus(opA.id, parseTransactionQuery({ betId: randomUUID() }))).rejects.toThrow(
      NotFoundException,
    );
  });

  test("a nonexistent transactionId (debit + payout forms) → 404", async () => {
    const opA = await freshOperator(["EUR"]);
    await expect(
      reporting.transactionStatus(
        opA.id,
        parseTransactionQuery({ transactionId: debitTxIdOf(randomUUID(), randomUUID(), "A") }),
      ),
    ).rejects.toThrow(NotFoundException);
    await expect(
      reporting.transactionStatus(opA.id, parseTransactionQuery({ transactionId: payoutTxIdOf(randomUUID()) })),
    ).rejects.toThrow(NotFoundException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("TXS.2 resolution — the SAME bet is reachable by every key form", () => {
  test("betId | debit txid | payout txid | restart_refund txid all resolve to the same bet", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "multi-key", "EUR");
    // panel B so the debit-form panel parse is exercised non-trivially.
    const bet = await seedBet(p.walletId, p.userId, {
      operatorId: op.id,
      amount: 1234n,
      status: "cashed_out",
      payout: 4321n,
      panel: "B",
      cashoutMult: 3.5,
      settledAt: new Date("2026-06-05T12:00:00Z"),
    });

    const byBetId = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    const byDebit = await reporting.transactionStatus(
      op.id,
      parseTransactionQuery({ transactionId: debitTxIdOf(bet.roundId, bet.userId, bet.panel) }),
    );
    const byPayout = await reporting.transactionStatus(
      op.id,
      parseTransactionQuery({ transactionId: payoutTxIdOf(bet.betId) }),
    );
    const byRestart = await reporting.transactionStatus(
      op.id,
      parseTransactionQuery({ transactionId: restartRefundTxIdOf(bet.betId) }),
    );

    for (const r of [byBetId, byDebit, byPayout, byRestart]) {
      expect(r.betId).toBe(bet.betId);
      expect(r.roundId).toBe(bet.roundId);
      expect(r.panel).toBe("B");
      expect(r.status).toBe("cashed_out");
      expect(r.stake).toBe("1234");
      expect(r.payout).toBe("4321");
      expect(r.playerId).toBe("multi-key");
    }
  });

  test("the debit form resolves via the compound (roundId,userId,panel) key — not the betId", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "compound-key", "EUR");
    const bet = await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 700n, status: "active", panel: "A" });
    // A debit txid built from roundId+userId+panel (NOT the betId) must find the row.
    const r = await reporting.transactionStatus(
      op.id,
      parseTransactionQuery({ transactionId: debitTxIdOf(bet.roundId, bet.userId, "A") }),
    );
    expect(r.betId).toBe(bet.betId);
    expect(r.query.kind).toBe("debit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("TXS.3 state mapping on real rows (debit/refund/payout dispositions)", () => {
  test("active → debit applied, refund none, payout none", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "st-active", "EUR");
    const bet = await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "active" });
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    expect(r.status).toBe("active");
    expect(r.debitState).toBe("applied");
    expect(r.refundState).toBe("none");
    expect(r.payoutState).toBe("none");
    expect(r.payout).toBe("0");
  });

  test("cashed_out → payout paid, payout amount > 0, debit applied", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "st-cashed", "EUR");
    const bet = await seedBet(p.walletId, p.userId, {
      operatorId: op.id,
      amount: 1000n,
      status: "cashed_out",
      payout: 2500n,
      cashoutMult: 2.5,
      settledAt: new Date("2026-06-04T10:00:00Z"),
    });
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    expect(r.payoutState).toBe("paid");
    expect(r.debitState).toBe("applied");
    expect(BigInt(r.payout) > 0n).toBe(true);
    expect(r.payout).toBe("2500");
    expect(r.cashoutMult).toBe("2.5");
    expect(r.settledAt).toBe("2026-06-04T10:00:00.000Z");
  });

  test("payout_pending → payout pending (win owed, operator credit unconfirmed)", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "st-pending", "EUR");
    const bet = await seedBet(p.walletId, p.userId, {
      operatorId: op.id,
      amount: 1000n,
      status: "payout_pending",
      payout: 1500n,
    });
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    expect(r.payoutState).toBe("pending");
    expect(r.debitState).toBe("applied");
    expect(r.payout).toBe("1500");
  });

  test("busted → debit applied, payout 0/none", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "st-busted", "EUR");
    const bet = await seedBet(p.walletId, p.userId, {
      operatorId: op.id,
      amount: 3000n,
      status: "busted",
      settledAt: new Date("2026-06-04T11:00:00Z"),
    });
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    expect(r.debitState).toBe("applied");
    expect(r.payoutState).toBe("none");
    expect(r.payout).toBe("0");
  });

  test("cancelled → debit reversed, refund applied", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "st-cancelled", "EUR");
    const bet = await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "cancelled" });
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    expect(r.debitState).toBe("reversed");
    expect(r.refundState).toBe("applied");
    expect(r.payoutState).toBe("none");
  });

  test("cancelling → debit applied, refund pending (refund in flight)", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "st-cancelling", "EUR");
    const bet = await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "cancelling" });
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    expect(r.debitState).toBe("applied");
    expect(r.refundState).toBe("pending");
  });

  test("reserving → debit pending (may or may not have applied)", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "st-reserving", "EUR");
    const bet = await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 1000n, status: "reserving" });
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    expect(r.debitState).toBe("pending");
    expect(r.refundState).toBe("none");
    expect(r.payoutState).toBe("none");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("TXS.4 null handling — never throws on nullable columns", () => {
  test("F-084: a NULL Bet.currency is REJECTED by the DB (NOT NULL constraint enforced)", async () => {
    // F-084 hardened Bet.currency to NOT NULL — the live placeBet always stamps the
    // wallet's code, so a null can only be a forgotten stamp; the constraint fails it loud.
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "null-ccy", "EUR");
    await expect(
      seedBet(p.walletId, p.userId, {
        operatorId: op.id,
        amount: 100n,
        status: "busted",
        currency: null, // F-084: no longer allowed — must be rejected
        settledAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  test("an UNKNOWN (unseeded) currency → decimals fallback 2, currency reflected", async () => {
    // The decimals fallback still matters with currency NOT NULL: a stamped-but-unseeded
    // code (offered by the operator, not yet in the canonical table) must not 500 the report.
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "unknown-ccy", "EUR");
    const bet = await seedBet(p.walletId, p.userId, {
      operatorId: op.id,
      amount: 100n,
      status: "busted",
      currency: "XYZ", // valid (non-null) but not in the canonical decimals table
      settledAt: new Date(),
    });
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    expect(r.currency).toBe("XYZ");
    expect(r.decimals).toBe(2); // fallback for an unknown currency
  });

  test("null cashoutMult and null settledAt serialize as null (active, unsettled)", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "null-fields", "EUR");
    const bet = await seedBet(p.walletId, p.userId, {
      operatorId: op.id,
      amount: 100n,
      status: "active",
      cashoutMult: null,
      settledAt: null,
    });
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    expect(r.cashoutMult).toBeNull();
    expect(r.settledAt).toBeNull();
  });

  test("a non-2-decimal currency (USDT=6) is reflected on the row", async () => {
    const op = await freshOperator(["USDT"]);
    const p = await makePlayer(op.id, "usdt-player", "USDT");
    const bet = await seedBet(p.walletId, p.userId, {
      operatorId: op.id,
      amount: 100n,
      status: "busted",
      currency: "USDT",
      settledAt: new Date(),
    });
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    expect(r.currency).toBe("USDT");
    expect(r.decimals).toBe(6); // non-2 canary
  });

  test("debitTxId / payoutTxId are echoed when stamped (best-effort references)", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "txid-stamps", "EUR");
    const bet = await seedBet(p.walletId, p.userId, {
      operatorId: op.id,
      amount: 100n,
      status: "cashed_out",
      payout: 250n,
      debitTxId: "op-debit-abc", // operator tx ids are arbitrary strings, NOT uuids
      payoutTxId: "op-payout-xyz",
      settledAt: new Date(),
    });
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    expect(r.debitTxId).toBe("op-debit-abc");
    expect(r.payoutTxId).toBe("op-payout-xyz");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("TXS.5 query echo — response reflects the caller's INPUT, not a derived value", () => {
  test("betId form → query.betId set, query.transactionId null, kind 'betId'", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "echo-betid", "EUR");
    const bet = await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 100n, status: "active" });
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ betId: bet.betId }));
    expect(r.query.kind).toBe("betId");
    expect(r.query.betId).toBe(bet.betId);
    expect(r.query.transactionId).toBeNull();
  });

  test("debit transactionId form → query.transactionId set, query.betId null, kind 'debit'", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "echo-debit", "EUR");
    const bet = await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 100n, status: "active" });
    const transactionId = debitTxIdOf(bet.roundId, bet.userId, bet.panel);
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ transactionId }));
    expect(r.query.kind).toBe("debit");
    expect(r.query.transactionId).toBe(transactionId);
    expect(r.query.betId).toBeNull();
  });

  test("payout transactionId form → query.transactionId set, query.betId null, kind 'payout'", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "echo-payout", "EUR");
    const bet = await seedBet(p.walletId, p.userId, {
      operatorId: op.id,
      amount: 100n,
      status: "cashed_out",
      payout: 250n,
      settledAt: new Date(),
    });
    const transactionId = payoutTxIdOf(bet.betId);
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ transactionId }));
    expect(r.query.kind).toBe("payout");
    expect(r.query.transactionId).toBe(transactionId);
    expect(r.query.betId).toBeNull();
  });

  test("restart_refund transactionId form → query.transactionId set, kind 'refund'", async () => {
    const op = await freshOperator(["EUR"]);
    const p = await makePlayer(op.id, "echo-restart", "EUR");
    const bet = await seedBet(p.walletId, p.userId, { operatorId: op.id, amount: 100n, status: "cancelled" });
    const transactionId = restartRefundTxIdOf(bet.betId);
    const r = await reporting.transactionStatus(op.id, parseTransactionQuery({ transactionId }));
    expect(r.query.kind).toBe("refund");
    expect(r.query.transactionId).toBe(transactionId);
    expect(r.query.betId).toBeNull();
  });
});
