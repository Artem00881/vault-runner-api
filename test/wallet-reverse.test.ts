import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { WalletRouter } from "../src/wallet/wallet-router";
import { SeamlessOperatorWallet, type OperatorSession } from "../src/wallet/seamless-operator-wallet";
import { MockOperator } from "./helpers/mock-operator";
import type { ReverseParams } from "../src/wallet/wallet-provider";

/**
 * Unit coverage for the NEW WalletProvider.reverse() leg of the operator-VOID
 * feature (Phase 6). reverse() ALWAYS returns the money, with mode-correct
 * bookkeeping:
 *   - internal ledger (LedgerService): posts the INVERSE entry under `reverseKey`
 *     — refund a `debit` = a `+amount` `refund` row; reclaim a `credit` =
 *     a `-amount` `payout_credit` row. Idempotent on `reverseKey`. A reclaim that
 *     exceeds the balance throws `insufficient_balance` and posts NOTHING.
 *   - operator wallet (SeamlessOperatorWallet): calls the operator's idempotent
 *     `rollback` on the ORIGINAL key (no new turnover / no GGR inflation) — and a
 *     failure PROPAGATES (it is the intended effect, not a swallowed compensation).
 *   - WalletRouter: dispatches reverse() by the wallet's persisted mode (demo →
 *     ledger; real → operator), so a void never posts play-money to a real wallet.
 *
 * Mirrors ledger.test.ts (freshWallet) and seamless-operator-wallet.test.ts.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);

async function freshWallet(balance: bigint): Promise<string> {
  const id = randomUUID();
  const user = await prisma.user.create({
    data: {
      id,
      username: "rev_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "rev" } },
    },
    include: { wallets: true },
  });
  return user.wallets[0].id;
}

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("LedgerService.reverse — internal inverse-entry bookkeeping", () => {
  test("refund a debit posts a +amount `refund`/refType:bet row under reverseKey", async () => {
    const w = await freshWallet(10_000n);
    const betId = randomUUID();
    // The original stake debit (so the balance reflects a placed bet).
    await ledger.debit(w, 1000n, "bet_debit", `bet:${betId}:debit`, { refType: "bet", refId: betId });
    expect(await ledger.getBalance(w)).toBe(9000n);

    const reverseKey = `bet:${betId}:void_refund`;
    await ledger.reverse(w, {
      originalKey: `bet:${betId}:debit`,
      reverseKey,
      amount: 1000n,
      originalDirection: "debit", // refund a stake debit → credit back
      type: "refund",
      ref: { refType: "bet", refId: betId },
    } satisfies ReverseParams);

    expect(await ledger.getBalance(w)).toBe(10_000n); // stake returned
    const row = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: reverseKey } });
    expect(row).not.toBeNull();
    expect(row!.type).toBe("refund");
    expect(row!.amount).toBe(1000n); // POSITIVE — money back into the wallet
    expect(row!.refType).toBe("bet");
    expect(row!.refId).toBe(betId);
  });

  test("reclaim a credit posts a -amount `payout_credit` row under reverseKey", async () => {
    const w = await freshWallet(10_000n);
    const betId = randomUUID();
    // The original payout credit (a won bet that paid out).
    await ledger.credit(w, 2500n, "payout_credit", `bet:${betId}:payout`, { refType: "bet", refId: betId });
    expect(await ledger.getBalance(w)).toBe(12_500n);

    const reverseKey = `bet:${betId}:void_reclaim`;
    await ledger.reverse(w, {
      originalKey: `bet:${betId}:payout`,
      reverseKey,
      amount: 2500n,
      originalDirection: "credit", // reclaim a payout credit → debit back
      type: "payout_credit",
      ref: { refType: "bet", refId: betId },
    });

    expect(await ledger.getBalance(w)).toBe(10_000n); // payout clawed back
    const row = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: reverseKey } });
    expect(row).not.toBeNull();
    expect(row!.type).toBe("payout_credit");
    expect(row!.amount).toBe(-2500n); // NEGATIVE payout_credit → nets the original in reconcile 1b
    expect(row!.refType).toBe("bet");
    expect(row!.refId).toBe(betId);
  });

  test("idempotent on reverseKey: a second reverse is a no-op (balance + rows unchanged)", async () => {
    const w = await freshWallet(10_000n);
    const betId = randomUUID();
    await ledger.debit(w, 1000n, "bet_debit", `bet:${betId}:debit`, { refType: "bet", refId: betId });
    const params: ReverseParams = {
      originalKey: `bet:${betId}:debit`,
      reverseKey: `bet:${betId}:void_refund`,
      amount: 1000n,
      originalDirection: "debit",
      type: "refund",
      ref: { refType: "bet", refId: betId },
    };
    await ledger.reverse(w, params);
    await ledger.reverse(w, params); // retry — must not double-refund
    await ledger.reverse(w, params); // and again

    expect(await ledger.getBalance(w)).toBe(10_000n); // refunded exactly once
    const refundRows = await prisma.ledgerTransaction.findMany({
      where: { walletId: w, type: "refund" },
    });
    expect(refundRows.length).toBe(1);
  });

  test("concurrent same-reverseKey reverses apply exactly once (refund once)", async () => {
    const w = await freshWallet(10_000n);
    const betId = randomUUID();
    await ledger.debit(w, 1000n, "bet_debit", `bet:${betId}:debit`, { refType: "bet", refId: betId });
    const params: ReverseParams = {
      originalKey: `bet:${betId}:debit`,
      reverseKey: `bet:${betId}:void_refund`,
      amount: 1000n,
      originalDirection: "debit",
      type: "refund",
      ref: { refType: "bet", refId: betId },
    };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => ledger.reverse(w, params)));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true); // idempotent, none throw
    expect(await ledger.getBalance(w)).toBe(10_000n); // applied once
    const refundRows = await prisma.ledgerTransaction.findMany({ where: { walletId: w, type: "refund" } });
    expect(refundRows.length).toBe(1);
  });

  test("a reclaim that EXCEEDS balance throws insufficient_balance and posts NOTHING (clawback-fail)", async () => {
    // The player won 2500 then spent it down to 500 — the operator can't reclaim
    // the full payout from the internal ledger. The void must abort cleanly.
    const w = await freshWallet(0n);
    const betId = randomUUID();
    await ledger.credit(w, 2500n, "payout_credit", `bet:${betId}:payout`, { refType: "bet", refId: betId });
    await ledger.debit(w, 2000n, "withdrawal", `spend:${randomUUID()}`); // spent most of it → 500 left
    expect(await ledger.getBalance(w)).toBe(500n);

    const reverseKey = `bet:${betId}:void_reclaim`;
    await expect(
      ledger.reverse(w, {
        originalKey: `bet:${betId}:payout`,
        reverseKey,
        amount: 2500n,
        originalDirection: "credit", // reclaim 2500 from a 500 balance → impossible
        type: "payout_credit",
        ref: { refType: "bet", refId: betId },
      }),
    ).rejects.toThrow("insufficient_balance");

    expect(await ledger.getBalance(w)).toBe(500n); // unchanged
    const reclaimRow = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: reverseKey } });
    expect(reclaimRow).toBeNull(); // NOTHING posted
  });

  test("table-driven: direction → (sign, type) of the inverse entry", async () => {
    const cases: Array<{
      name: string;
      dir: "debit" | "credit";
      type: "refund" | "payout_credit";
      amount: bigint;
      expectSign: 1 | -1;
    }> = [
      { name: "refund a debit → +refund", dir: "debit", type: "refund", amount: 700n, expectSign: 1 },
      { name: "reclaim a credit → -payout_credit", dir: "credit", type: "payout_credit", amount: 900n, expectSign: -1 },
    ];
    for (const c of cases) {
      const w = await freshWallet(100_000n);
      const betId = randomUUID();
      const reverseKey = `bet:${betId}:rev`;
      await ledger.reverse(w, {
        originalKey: `bet:${betId}:orig`,
        reverseKey,
        amount: c.amount,
        originalDirection: c.dir,
        type: c.type,
        ref: { refType: "bet", refId: betId },
      });
      const row = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: reverseKey } });
      expect(row!.type).toBe(c.type);
      expect(row!.amount).toBe(c.amount * BigInt(c.expectSign));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("SeamlessOperatorWallet.reverse — rolls back the ORIGINAL operator tx", () => {
  const SESSION: OperatorSession = { operatorId: "opR", playerId: "pR", currency: "EUR", roundId: "rR" };
  const resolver = async (_w: string) => SESSION;

  test("reverse calls rollback on the ORIGINAL key (no new bet/win turnover)", async () => {
    const op = new MockOperator({ "pR:EUR": 1000 });
    const wallet = new SeamlessOperatorWallet(op, resolver);
    // Original payout the operator applied.
    await wallet.credit("w1", 250n, "payout_credit", "bet:b1:payout", { refType: "bet", refId: "b1" });
    expect(op.balanceOf("pR", "EUR")).toBe(1250n);
    const betsBefore = op.calls.bet;
    const winsBefore = op.calls.win;

    // reverse → rollback of bet:b1:payout (the ORIGINAL key, not the reverseKey).
    await wallet.reverse("w1", {
      originalKey: "bet:b1:payout",
      reverseKey: "bet:b1:void_reclaim", // ignored by operator mode
      amount: 250n,
      originalDirection: "credit",
      type: "payout_credit",
      ref: { refType: "bet", refId: "b1" },
    });

    expect(op.balanceOf("pR", "EUR")).toBe(1000n); // payout undone on the operator's statement
    expect(op.calls.rollback).toBe(1);
    expect(op.calls.bet).toBe(betsBefore); // NO new turnover
    expect(op.calls.win).toBe(winsBefore);
  });

  test("reverse is idempotent at the operator on the original key (repeat rollback = no-op)", async () => {
    const op = new MockOperator({ "pR:EUR": 1000 });
    const wallet = new SeamlessOperatorWallet(op, resolver);
    await wallet.debit("w1", 100n, "bet_debit", "bet:r1:debit", { refType: "bet", refId: "b1" });
    expect(op.balanceOf("pR", "EUR")).toBe(900n);
    const params: ReverseParams = {
      originalKey: "bet:r1:debit",
      reverseKey: "bet:b1:void_refund",
      amount: 100n,
      originalDirection: "debit",
      type: "refund",
      ref: { refType: "bet", refId: "b1" },
    };
    await wallet.reverse("w1", params);
    await wallet.reverse("w1", params); // repeat — must not double-reverse
    expect(op.balanceOf("pR", "EUR")).toBe(1000n); // restored once
    expect(op.calls.rollback).toBe(2); // called twice, but second is a no-op at the operator
  });

  test("a FAILED reverse PROPAGATES (intended effect, not swallowed)", async () => {
    // Unlike a debit's ambiguous-failure compensation (safeRollback swallows the
    // error), reverse() must SURFACE a failure so the caller aborts the void. The
    // MockOperator's misbehave hooks don't cover rollback, so use a tiny operator
    // whose rollback throws (e.g. the operator rejects clawing back a spent payout).
    const throwingOp: any = {
      rollback: async () => {
        throw new Error("operator_rollback_rejected");
      },
    };
    const wallet = new SeamlessOperatorWallet(throwingOp, resolver);
    await expect(
      wallet.reverse("w1", {
        originalKey: "bet:f1:payout",
        reverseKey: "bet:b1:void_reclaim",
        amount: 250n,
        originalDirection: "credit",
        type: "payout_credit",
        ref: { refType: "bet", refId: "b1" },
      }),
    ).rejects.toThrow("operator_rollback_rejected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("WalletRouter.reverse — dispatch by persisted wallet mode", () => {
  test("a DEMO wallet reverses on the LEDGER (no operator call)", async () => {
    const w = await freshWallet(10_000n);
    const betId = randomUUID();
    await ledger.debit(w, 1000n, "bet_debit", `bet:${betId}:debit`, { refType: "bet", refId: betId });

    const op = new MockOperator({ "p:EUR": 1000 });
    const seamless = new SeamlessOperatorWallet(op, async () => ({ operatorId: "o", playerId: "p", currency: "EUR" }));
    const router = new WalletRouter(ledger, seamless, async () => true); // demo → ledger

    await router.reverse(w, {
      originalKey: `bet:${betId}:debit`,
      reverseKey: `bet:${betId}:void_refund`,
      amount: 1000n,
      originalDirection: "debit",
      type: "refund",
      ref: { refType: "bet", refId: betId },
    });

    expect(await ledger.getBalance(w)).toBe(10_000n); // refunded on the ledger
    expect(op.calls.rollback).toBe(0); // operator never touched
    const row = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: `bet:${betId}:void_refund` } });
    expect(row!.type).toBe("refund");
  });

  test("a REAL wallet reverses at the OPERATOR (no ledger row)", async () => {
    const w = await freshWallet(10_000n); // a journal wallet; balance untouched in operator mode
    const op = new MockOperator({ "p:EUR": 1000 });
    const seamless = new SeamlessOperatorWallet(op, async () => ({ operatorId: "o", playerId: "p", currency: "EUR" }));
    const router = new WalletRouter(ledger, seamless, async () => false); // real → operator

    await op.bet("o", { playerId: "p", currency: "EUR", amount: "100", transactionId: `bet:${w}:debit`, roundId: "", betId: "b" });
    expect(op.balanceOf("p", "EUR")).toBe(900n);

    await router.reverse(w, {
      originalKey: `bet:${w}:debit`,
      reverseKey: `bet:${w}:void_refund`,
      amount: 100n,
      originalDirection: "debit",
      type: "refund",
      ref: { refType: "bet", refId: "b" },
    });

    expect(op.balanceOf("p", "EUR")).toBe(1000n); // reversed at the operator
    expect(op.calls.rollback).toBe(1);
    // No internal ledger inverse row was written for an operator wallet.
    const row = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: `bet:${w}:void_refund` } });
    expect(row).toBeNull();
  });
});
