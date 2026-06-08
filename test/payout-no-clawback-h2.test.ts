import { test, expect } from "bun:test";
import { MockOperator } from "./helpers/mock-operator";
import { SeamlessOperatorWallet, type OperatorSession } from "../src/wallet/seamless-operator-wallet";

/**
 * Audit H2 — a WON payout must NEVER be clawed back.
 *
 * The bug being locked in: previously a CREDIT (win) shared the DEBIT's failure
 * policy — on an ambiguous failure (timeout) it issued a `rollback` for the
 * transactionId. But a win the operator may already have APPLIED would then be
 * undone, robbing the player of an earned payout. The fix splits the policy:
 *
 *  - WIN (credit): retry the idempotent win; if still unconfirmed after
 *    `maxRetries`, throw `payout_pending` with ZERO rollbacks (the credit, if it
 *    applied, stays — the caller's reconciler re-issues the idempotent win later).
 *  - BET (debit): unchanged — timeout → compensating rollback → `wallet_unavailable`.
 *
 * No DB: a SeamlessOperatorWallet over the in-memory MockOperator, with a fixed
 * session resolver (same shape as seamless-operator-wallet.test.ts).
 */

const SESSION: OperatorSession = { operatorId: "op1", playerId: "p1", currency: "EUR", roundId: "r1" };
const resolver = async (_walletId: string) => SESSION;
const KEY = "p1:EUR"; // mock balance key
const ref = (id: string) => ({ refType: "bet", refId: id });

// maxRetries:1 so a single armed failure exhausts retries immediately (the
// MockOperator only misbehaves ONCE, so >1 retries would just succeed on retry).
function make(startBalance: number, maxRetries = 1) {
  const op = new MockOperator({ [KEY]: startBalance });
  const wallet = new SeamlessOperatorWallet(op, resolver, { maxRetries });
  return { op, wallet };
}

// A win can fail ambiguously two ways: the operator applied it then the line
// dropped (timeout_after_apply), or a hard error before/at apply (error). In
// BOTH cases the fix must surface payout_pending and roll back NOTHING.
const WIN_FAILURES: { name: string; kind: "timeout_after_apply" | "error"; applied: boolean }[] = [
  { name: "timeout-after-apply (operator credited, we never saw the reply)", kind: "timeout_after_apply", applied: true },
  { name: "hard error (nothing applied)", kind: "error", applied: false },
];

for (const f of WIN_FAILURES) {
  test(`H2: win failure (${f.name}) → payout_pending, NO rollback, the credit (if applied) is NOT reversed`, async () => {
    const { op, wallet } = make(1000);
    op.misbehaveOnce({ kind: f.kind });

    await expect(
      wallet.credit("w1", 250n, "payout_credit", "bet:bWIN:payout", ref("bWIN")),
    ).rejects.toThrow("payout_pending");

    // THE invariant: a won payout is never clawed back.
    expect(op.calls.rollback).toBe(0);

    // The balance reflects whether the operator applied the credit, and it is
    // left exactly as the operator has it — never decreased by a rollback. A
    // timeout-after-apply leaves +250; a pre-apply error leaves it untouched.
    const expected = f.applied ? 1250n : 1000n;
    expect(op.balanceOf("p1", "EUR")).toBe(expected);
  });
}

test("H2: a later idempotent retry of the SAME payout key confirms once — never double-pays", async () => {
  // Models what reconcilePendingPayouts() does: re-issue the SAME win key. If it
  // already applied during the timeout, the operator dedups; if not, it pays now.
  // Either way the player ends +250 exactly, and we still never rolled back.
  const { op, wallet } = make(1000);
  const k = "bet:bRECON:payout";

  op.misbehaveOnce({ kind: "timeout_after_apply" }); // applied at the operator, +250
  await expect(wallet.credit("w1", 250n, "payout_credit", k, ref("bRECON"))).rejects.toThrow("payout_pending");
  expect(op.balanceOf("p1", "EUR")).toBe(1250n);

  // Reconciler re-issue: same key → operator returns the SAME result, no re-apply.
  const c = await wallet.credit("w1", 250n, "payout_credit", k, ref("bRECON"));
  expect(c.balanceAfter).toBe(1250n);
  expect(op.balanceOf("p1", "EUR")).toBe(1250n); // not 1500
  expect(op.calls.rollback).toBe(0); // still zero — a won payout is never reversed
});

test("CONTRAST: a DEBIT timeout DOES still roll back (wallet_unavailable) — the bet policy is unchanged", async () => {
  // Guards against an over-broad fix that would also stop compensating bets.
  const { op, wallet } = make(1000);
  op.misbehaveOnce({ kind: "timeout_after_apply" }); // operator debited, we time out
  await expect(
    wallet.debit("w1", 100n, "bet_debit", "bet:bBET:debit", ref("bBET")),
  ).rejects.toThrow("wallet_unavailable");

  // The debit path compensates: exactly one rollback, balance restored to 1000.
  expect(op.calls.rollback).toBe(1);
  expect(op.balanceOf("p1", "EUR")).toBe(1000n);
});
