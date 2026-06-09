import { test, expect, describe } from "bun:test";
import { MockOperator } from "./helpers/mock-operator";
import { SeamlessOperatorWallet, type OperatorSession } from "../src/wallet/seamless-operator-wallet";
import type { ReverseParams } from "../src/wallet/wallet-provider";
import type { RollbackStore, RollbackRef } from "../src/wallet/wallet-rollback.service";

// A fixed session: our internal walletId → operator player/currency.
const SESSION: OperatorSession = { operatorId: "op1", playerId: "p1", currency: "EUR", roundId: "r1" };
const resolver = async (_walletId: string) => SESSION;
const KEY = "p1:EUR"; // mock balance key

function make(startBalance: number) {
  const op = new MockOperator({ [KEY]: startBalance });
  const wallet = new SeamlessOperatorWallet(op, resolver);
  return { op, wallet };
}

test("happy path: debit then credit hit the operator and return its balance", async () => {
  const { op, wallet } = make(1000);
  const d = await wallet.debit("w1", 100n, "bet_debit", "bet:b1:debit", { refType: "bet", refId: "b1" });
  expect(d.balanceAfter).toBe(900n);
  expect(op.balanceOf("p1", "EUR")).toBe(900n);

  const c = await wallet.credit("w1", 250n, "payout_credit", "bet:b1:payout", { refType: "bet", refId: "b1" });
  expect(c.balanceAfter).toBe(1150n);
  expect(op.balanceOf("p1", "EUR")).toBe(1150n);
  expect(op.calls.bet).toBe(1);
  expect(op.calls.win).toBe(1);
});

test("insufficient funds is a clean rejection (insufficient_balance)", async () => {
  const { op, wallet } = make(50);
  await expect(
    wallet.debit("w1", 100n, "bet_debit", "bet:b2:debit", { refType: "bet", refId: "b2" }),
  ).rejects.toThrow("insufficient_balance");
  expect(op.balanceOf("p1", "EUR")).toBe(50n); // unchanged
});

test("idempotency: the same transactionId never double-charges", async () => {
  const { op, wallet } = make(1000);
  const a = await wallet.debit("w1", 100n, "bet_debit", "bet:b3:debit", { refType: "bet", refId: "b3" });
  const b = await wallet.debit("w1", 100n, "bet_debit", "bet:b3:debit", { refType: "bet", refId: "b3" });
  expect(a.balanceAfter).toBe(900n);
  expect(b.balanceAfter).toBe(900n); // applied once at the operator
  expect(op.balanceOf("p1", "EUR")).toBe(900n);
});

test("FAILURE MODE 1 — timeout-after-apply: operator charged but we time out → rollback restores balance", async () => {
  const { op, wallet } = make(1000);
  op.misbehaveOnce({ kind: "timeout_after_apply" }); // operator debits, we never get the response
  await expect(
    wallet.debit("w1", 100n, "bet_debit", "bet:b4:debit", { refType: "bet", refId: "b4" }),
  ).rejects.toThrow("wallet_unavailable");
  // The provider compensated with a rollback → player's balance is NOT down 100.
  expect(op.balanceOf("p1", "EUR")).toBe(1000n);
  expect(op.calls.rollback).toBe(1);
});

test("FAILURE MODE 2 — double-credit: a repeated win does not pay twice", async () => {
  const { op, wallet } = make(1000);
  const k = "bet:b5:payout";
  const a = await wallet.credit("w1", 200n, "payout_credit", k, { refType: "bet", refId: "b5" });
  const b = await wallet.credit("w1", 200n, "payout_credit", k, { refType: "bet", refId: "b5" });
  expect(a.balanceAfter).toBe(1200n);
  expect(b.balanceAfter).toBe(1200n); // not 1400 — operator dedups on transactionId
  expect(op.balanceOf("p1", "EUR")).toBe(1200n);
});

test("FAILURE MODE 3 — late rollback of a transaction that never applied is a safe no-op", async () => {
  const { op, wallet } = make(1000);
  // never debited bet:b6 — rolling it back must not change the balance
  await wallet.rollback("w1", "bet:b6:debit", { refType: "bet", refId: "b6" });
  expect(op.balanceOf("p1", "EUR")).toBe(1000n);
  expect(op.calls.rollback).toBe(1);
});

test("timeout-before-apply: nothing charged, rollback no-op, balance intact", async () => {
  const { op, wallet } = make(1000);
  op.misbehaveOnce({ kind: "timeout_before_apply" });
  await expect(
    wallet.debit("w1", 100n, "bet_debit", "bet:b7:debit", { refType: "bet", refId: "b7" }),
  ).rejects.toThrow("wallet_unavailable");
  expect(op.balanceOf("p1", "EUR")).toBe(1000n);
});

test("getBalance reads through to the operator", async () => {
  const { wallet } = make(777);
  expect(await wallet.getBalance("w1")).toBe(777n);
});

/**
 * GDPR + caps batch (#1) — assertTxIdLength: a defensive bound (MAX_OUTBOUND_TX_ID_LEN = 200) on
 * the OUTBOUND operator `transactionId` (our generated idempotency key, NEVER operator input).
 *
 * It guards every choke point that puts a transactionId on the wire — move() (bet=debit /
 * win=credit) and rollbackOnce() (the rollback / reverse paths). A breach (a key-format bug
 * upstream) THROWS rather than silently sending an oversized id or truncating one (truncation
 * would change the operator dedup key → break exactly-once). We assert:
 *   - a 201-char key throws on debit, credit, rollback, and reverse;
 *   - the throw happens BEFORE any operator call (op.calls all 0) and BEFORE any rollback-store
 *     row is written (the once-only durable claim is never staked);
 *   - the operator balance is untouched;
 *   - an ~85-char real-shaped key passes through unchanged on every path (value untouched).
 */
describe("#1 assertTxIdLength — outbound transactionId bound (200)", () => {
  const over = "x".repeat(201); // one over the cap
  // A realistic structured key: `bet:{roundUuid}:{userUuid}:A:debit` ≈ 85 chars (see reporting-query.ts).
  const real = "bet:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222:A:debit";

  // A RollbackStore spy: records whether claim() was reached (so we can prove an over-long key on
  // the reverse/rollback path throws BEFORE the once-only durable row is staked).
  function spyStore() {
    const calls = { claim: 0, confirm: 0, recordEmitFailure: 0 };
    const store: RollbackStore = {
      async claim(_c) {
        calls.claim++;
        const ref: RollbackRef = { operatorId: "op1", dedupeKey: "spy" };
        return { alreadyConfirmed: false, inFlight: false, ref };
      },
      async confirm(_ref) {
        calls.confirm++;
      },
      async recordEmitFailure(_ref, _err) {
        calls.recordEmitFailure++;
      },
    };
    return { store, calls };
  }

  test("a 201-char transactionId THROWS on debit + credit, with NO operator call and balance intact", async () => {
    const { op, wallet } = make(1000);
    await expect(wallet.debit("w1", 100n, "bet_debit", over, { refType: "bet", refId: "b1" })).rejects.toThrow(
      /transactionId exceeds 200/,
    );
    await expect(wallet.credit("w1", 100n, "payout_credit", over, { refType: "bet", refId: "b1" })).rejects.toThrow(
      /transactionId exceeds 200/,
    );
    // The assertion fires before the wire call — the operator was never hit, balance unchanged.
    expect(op.calls.bet).toBe(0);
    expect(op.calls.win).toBe(0);
    expect(op.balanceOf("p1", "EUR")).toBe(1000n);
  });

  test("a 201-char transactionId THROWS on reverse with NO operator rollback AND NO rollback-store row", async () => {
    const op = new MockOperator({ [KEY]: 1000 });
    const { store, calls } = spyStore();
    const wallet = new SeamlessOperatorWallet(op, resolver, {}, store);

    const params: ReverseParams = {
      originalKey: over, // the OUTBOUND key the operator dedups on — over the cap
      reverseKey: "bet:b1:void_refund",
      amount: 100n,
      originalDirection: "debit",
      type: "refund",
      ref: { refType: "bet", refId: "b1" },
    };
    await expect(wallet.reverse("w1", params)).rejects.toThrow(/transactionId exceeds 200/);

    // assertTxIdLength is the FIRST line of rollbackOnce → no operator emit, no durable claim staked.
    expect(op.calls.rollback).toBe(0);
    expect(calls.claim).toBe(0);
    expect(calls.confirm).toBe(0);
    expect(calls.recordEmitFailure).toBe(0);
    expect(op.balanceOf("p1", "EUR")).toBe(1000n);
  });

  test("a 201-char transactionId THROWS on rollback() (ambiguous-debit compensation path)", async () => {
    const op = new MockOperator({ [KEY]: 1000 });
    const { store, calls } = spyStore();
    const wallet = new SeamlessOperatorWallet(op, resolver, {}, store);
    // rollback() is the swallow-on-failure path — but assertTxIdLength throws synchronously BEFORE
    // the try/emit, so even this best-effort path surfaces the programming error.
    await expect(wallet.rollback("w1", over, { refType: "bet", refId: "b1" })).rejects.toThrow(
      /transactionId exceeds 200/,
    );
    expect(op.calls.rollback).toBe(0);
    expect(calls.claim).toBe(0);
  });

  test("an ~85-char real key passes UNCHANGED on debit, credit, rollback, and reverse (value untouched)", async () => {
    expect(real.length).toBeLessThanOrEqual(200);
    expect(real.length).toBeGreaterThan(80);

    // debit + credit go through and hit the operator with the EXACT key (the mock dedups on it).
    const { op, wallet } = make(1000);
    const d = await wallet.debit("w1", 100n, "bet_debit", real, { refType: "bet", refId: "b1" });
    expect(d.balanceAfter).toBe(900n);
    const winKey = real.replace(":debit", ":payout");
    const c = await wallet.credit("w1", 50n, "payout_credit", winKey, { refType: "bet", refId: "b1" });
    expect(c.balanceAfter).toBe(950n);
    expect(op.calls.bet).toBe(1);
    expect(op.calls.win).toBe(1);

    // reverse + rollback with a real key reach the operator (no throw).
    const op2 = new MockOperator({ [KEY]: 1000 });
    const { store, calls } = spyStore();
    const wallet2 = new SeamlessOperatorWallet(op2, resolver, {}, store);
    await wallet2.reverse("w1", {
      originalKey: real,
      reverseKey: "bet:b1:void_refund",
      amount: 100n,
      originalDirection: "debit",
      type: "refund",
      ref: { refType: "bet", refId: "b1" },
    });
    expect(op2.calls.rollback).toBe(1); // emitted (store said not-confirmed → emit)
    expect(calls.claim).toBe(1); // the durable claim WAS staked for a valid key
    expect(calls.confirm).toBe(1);

    // The unwired rollback() path (no store) also reaches the operator with the exact key.
    const { op: op3, wallet: wallet3 } = make(1000);
    await wallet3.rollback("w1", real, { refType: "bet", refId: "b1" });
    expect(op3.calls.rollback).toBe(1);
  });

  test("boundary: exactly 200 chars is allowed (passes assertTxIdLength); 201 is the first rejected", async () => {
    const { op, wallet } = make(1000);
    const at200 = "z".repeat(200);
    // Exactly at the cap — no throw, operator hit.
    const r = await wallet.debit("w1", 10n, "bet_debit", at200, { refType: "bet", refId: "b1" });
    expect(r.balanceAfter).toBe(990n);
    expect(op.calls.bet).toBe(1);
    // 201 — rejected.
    await expect(wallet.debit("w1", 10n, "bet_debit", "z".repeat(201), { refType: "bet", refId: "b2" })).rejects.toThrow(
      /transactionId exceeds 200/,
    );
  });
});
