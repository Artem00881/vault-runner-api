import { test, expect } from "bun:test";
import { MockOperator } from "./helpers/mock-operator";
import { SeamlessOperatorWallet, type OperatorSession } from "../src/wallet/seamless-operator-wallet";

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
  expect(op.balanceOf("p1", "EUR")).toBe(900);

  const c = await wallet.credit("w1", 250n, "payout_credit", "bet:b1:payout", { refType: "bet", refId: "b1" });
  expect(c.balanceAfter).toBe(1150n);
  expect(op.balanceOf("p1", "EUR")).toBe(1150);
  expect(op.calls.bet).toBe(1);
  expect(op.calls.win).toBe(1);
});

test("insufficient funds is a clean rejection (insufficient_balance)", async () => {
  const { op, wallet } = make(50);
  await expect(
    wallet.debit("w1", 100n, "bet_debit", "bet:b2:debit", { refType: "bet", refId: "b2" }),
  ).rejects.toThrow("insufficient_balance");
  expect(op.balanceOf("p1", "EUR")).toBe(50); // unchanged
});

test("idempotency: the same transactionId never double-charges", async () => {
  const { op, wallet } = make(1000);
  const a = await wallet.debit("w1", 100n, "bet_debit", "bet:b3:debit", { refType: "bet", refId: "b3" });
  const b = await wallet.debit("w1", 100n, "bet_debit", "bet:b3:debit", { refType: "bet", refId: "b3" });
  expect(a.balanceAfter).toBe(900n);
  expect(b.balanceAfter).toBe(900n); // applied once at the operator
  expect(op.balanceOf("p1", "EUR")).toBe(900);
});

test("FAILURE MODE 1 — timeout-after-apply: operator charged but we time out → rollback restores balance", async () => {
  const { op, wallet } = make(1000);
  op.misbehaveOnce({ kind: "timeout_after_apply" }); // operator debits, we never get the response
  await expect(
    wallet.debit("w1", 100n, "bet_debit", "bet:b4:debit", { refType: "bet", refId: "b4" }),
  ).rejects.toThrow("wallet_unavailable");
  // The provider compensated with a rollback → player's balance is NOT down 100.
  expect(op.balanceOf("p1", "EUR")).toBe(1000);
  expect(op.calls.rollback).toBe(1);
});

test("FAILURE MODE 2 — double-credit: a repeated win does not pay twice", async () => {
  const { op, wallet } = make(1000);
  const k = "bet:b5:payout";
  const a = await wallet.credit("w1", 200n, "payout_credit", k, { refType: "bet", refId: "b5" });
  const b = await wallet.credit("w1", 200n, "payout_credit", k, { refType: "bet", refId: "b5" });
  expect(a.balanceAfter).toBe(1200n);
  expect(b.balanceAfter).toBe(1200n); // not 1400 — operator dedups on transactionId
  expect(op.balanceOf("p1", "EUR")).toBe(1200);
});

test("FAILURE MODE 3 — late rollback of a transaction that never applied is a safe no-op", async () => {
  const { op, wallet } = make(1000);
  // never debited bet:b6 — rolling it back must not change the balance
  await wallet.rollback("w1", "bet:b6:debit", { refType: "bet", refId: "b6" });
  expect(op.balanceOf("p1", "EUR")).toBe(1000);
  expect(op.calls.rollback).toBe(1);
});

test("timeout-before-apply: nothing charged, rollback no-op, balance intact", async () => {
  const { op, wallet } = make(1000);
  op.misbehaveOnce({ kind: "timeout_before_apply" });
  await expect(
    wallet.debit("w1", 100n, "bet_debit", "bet:b7:debit", { refType: "bet", refId: "b7" }),
  ).rejects.toThrow("wallet_unavailable");
  expect(op.balanceOf("p1", "EUR")).toBe(1000);
});

test("getBalance reads through to the operator", async () => {
  const { wallet } = make(777);
  expect(await wallet.getBalance("w1")).toBe(777n);
});
