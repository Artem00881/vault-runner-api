import { test, expect } from "bun:test";
import { startSandboxOperator } from "./helpers/sandbox-operator";
import { HttpOperatorWalletApi } from "../src/wallet/http-operator-wallet";
import { SeamlessOperatorWallet, type OperatorSession } from "../src/wallet/seamless-operator-wallet";

// FULL CHAIN over a real socket: the game-facing WalletProvider
// (SeamlessOperatorWallet) → the HTTP client → a live HTTP operator. Proves the
// Phase-0.2 safety model (idempotency + compensating rollback on ambiguity)
// holds over genuine transport, not just the in-memory mock. No DB.

const SESSION: OperatorSession = { operatorId: "op1", playerId: "p1", currency: "EUR", roundId: "r1" };
const resolver = async (_walletId: string) => SESSION;
const ref = (id: string) => ({ refType: "bet", refId: id });

function make(startBalance: number, opts: { timeoutMs?: number } = {}) {
  const sandbox = startSandboxOperator({ seed: { "p1:EUR": startBalance }, apiKey: "k" });
  const client = new HttpOperatorWalletApi(
    async () => ({ walletApiUrl: sandbox.url, walletApiKey: "k" }),
    { timeoutMs: opts.timeoutMs ?? 1000 },
  );
  const wallet = new SeamlessOperatorWallet(client, resolver);
  return { sandbox, wallet };
}

test("e2e happy path: debit + credit move the real operator balance over HTTP", async () => {
  const { sandbox, wallet } = make(1000);
  const d = await wallet.debit("w1", 100n, "bet_debit", "bet:b1:debit", ref("b1"));
  expect(d.balanceAfter).toBe(900n);
  const c = await wallet.credit("w1", 250n, "payout_credit", "bet:b1:payout", ref("b1"));
  expect(c.balanceAfter).toBe(1150n);
  expect(await wallet.getBalance("w1")).toBe(1150n);
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(1150n);
  sandbox.stop();
});

test("e2e insufficient funds → insufficient_balance (operator unchanged)", async () => {
  const { sandbox, wallet } = make(50);
  await expect(
    wallet.debit("w1", 100n, "bet_debit", "bet:b2:debit", ref("b2")),
  ).rejects.toThrow("insufficient_balance");
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(50n);
  sandbox.stop();
});

test("e2e FAILURE MODE — timeout-after-apply over HTTP → compensating rollback restores balance", async () => {
  const { sandbox, wallet } = make(1000, { timeoutMs: 100 });
  // The operator DEBITS, then the line drops before we get the response.
  sandbox.arm({ delayMs: 400, applyBeforeDelay: true });
  await expect(
    wallet.debit("w1", 100n, "bet_debit", "bet:b3:debit", ref("b3")),
  ).rejects.toThrow("wallet_unavailable");
  // The provider compensated with a rollback → player is NOT down 100.
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(1000n);
  expect(sandbox.operator.calls.rollback).toBe(1);
  sandbox.stop();
});

test("e2e double-credit is paid once (operator dedups on transactionId)", async () => {
  const { sandbox, wallet } = make(1000);
  const k = "bet:b4:payout";
  const a = await wallet.credit("w1", 200n, "payout_credit", k, ref("b4"));
  const b = await wallet.credit("w1", 200n, "payout_credit", k, ref("b4"));
  expect(a.balanceAfter).toBe(1200n);
  expect(b.balanceAfter).toBe(1200n); // not 1400
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(1200n);
  sandbox.stop();
});

test("e2e late rollback of a never-applied tx is a safe no-op", async () => {
  const { sandbox, wallet } = make(1000);
  await wallet.rollback("w1", "bet:b5:debit", ref("b5"));
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(1000n);
  expect(sandbox.operator.calls.rollback).toBe(1);
  sandbox.stop();
});

// F-001b/c TEETH (full chain over a real socket): a stake ABOVE 2^53 minor units
// flows SeamlessOperatorWallet → HTTP client → live operator and round-trips EXACT.
// The balance is chosen NON-double-representable so the pre-fix `number` wire would
// have corrupted the wei amount + balance — this test fails on the old encoding.
test("e2e high-decimal: a >2^53 wei stake round-trips BigInt-exact end to end", async () => {
  const start = 10n ** 18n; // 1 ETH in wei
  const stake = 123456789012345678n; // a "messy" wei stake (> Number.MAX_SAFE_INTEGER)
  const sandbox = startSandboxOperator({ seed: { "p1:EUR": start }, apiKey: "k" });
  const client = new HttpOperatorWalletApi(
    async () => ({ walletApiUrl: sandbox.url, walletApiKey: "k" }),
    { timeoutMs: 1000 },
  );
  const wallet = new SeamlessOperatorWallet(client, resolver);

  const expectedAfter = start - stake; // 876543210987654322n — NOT representable as a double
  // Guard the guard: this value genuinely loses precision through a JS number, so the
  // old `number` wire WOULD have corrupted it (the assertions below therefore have teeth).
  expect(BigInt(Math.trunc(Number(expectedAfter.toString())))).not.toBe(expectedAfter);

  const d = await wallet.debit("w1", stake, "bet_debit", "bet:hi:debit", ref("hi"));
  expect(d.balanceAfter).toBe(expectedAfter); // exact bigint through the provider
  expect(await wallet.getBalance("w1")).toBe(expectedAfter); // string off the wire → exact bigint
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(expectedAfter); // operator booked the exact wei
  expect(expectedAfter).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  sandbox.stop();
});
