import { test, expect } from "bun:test";
import { startSandboxOperator } from "./helpers/sandbox-operator";
import { HttpOperatorWalletApi } from "../src/wallet/http-operator-wallet";
import {
  OperatorInsufficientFunds,
  OperatorTimeout,
  OperatorError,
} from "../src/wallet/operator-wallet.types";

// Transport-level contract tests: the real HttpOperatorWalletApi talking to a
// real (in-process) HTTP operator over a genuine socket. No DB, no Nest.

const OP = "op1";
// F-001b/c: amount is a BigInt-safe decimal STRING on the wire (was number).
const req = (amount: number | bigint, id: string) => ({
  playerId: "p1",
  currency: "EUR",
  amount: amount.toString(),
  transactionId: id,
  roundId: "r1",
  betId: id,
});

function make(startBalance: number, opts: { timeoutMs?: number; apiKey?: string } = {}) {
  const key = opts.apiKey ?? "k";
  const sandbox = startSandboxOperator({ seed: { "p1:EUR": startBalance }, apiKey: key });
  const client = new HttpOperatorWalletApi(
    async () => ({ walletApiUrl: sandbox.url, walletApiKey: key }),
    { timeoutMs: opts.timeoutMs ?? 1000 },
  );
  return { sandbox, client };
}

test("bet debits over HTTP and returns the operator's balance", async () => {
  const { sandbox, client } = make(1000);
  const r = await client.bet(OP, req(100, "t1"));
  expect(r.balance).toBe("900"); // F-001c: BigInt-safe decimal string on the wire
  expect(BigInt(r.balance)).toBe(900n);
  expect(typeof r.operatorTxId).toBe("string");
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(900n);
  sandbox.stop();
});

test("the wallet API key is sent as a Bearer token", async () => {
  const { sandbox, client } = make(1000, { apiKey: "secret-123" });
  await client.bet(OP, req(10, "t1"));
  expect(sandbox.getLastAuth()).toBe("Bearer secret-123");
  sandbox.stop();
});

test("win credits over HTTP", async () => {
  const { sandbox, client } = make(1000);
  const r = await client.win(OP, req(250, "w1"));
  expect(r.balance).toBe("1250"); // F-001c: BigInt-safe decimal string
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(1250n);
  sandbox.stop();
});

test("balance() reads through to the operator", async () => {
  const { sandbox, client } = make(777);
  expect(await client.balance(OP, "p1", "EUR")).toBe("777"); // F-001c: string
  sandbox.stop();
});

test("insufficient funds (HTTP 402) → OperatorInsufficientFunds", async () => {
  const { sandbox, client } = make(50);
  await expect(client.bet(OP, req(100, "t1"))).rejects.toBeInstanceOf(OperatorInsufficientFunds);
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(50n);
  sandbox.stop();
});

test("operator 500 → OperatorError", async () => {
  const { sandbox, client } = make(1000);
  sandbox.arm({ status: 500 });
  await expect(client.bet(OP, req(100, "t1"))).rejects.toBeInstanceOf(OperatorError);
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(1000n);
  sandbox.stop();
});

test("client timeout (operator hangs) → OperatorTimeout", async () => {
  const { sandbox, client } = make(1000, { timeoutMs: 100 });
  sandbox.arm({ delayMs: 400 }); // operator hangs longer than the client waits
  await expect(client.bet(OP, req(100, "t1"))).rejects.toBeInstanceOf(OperatorTimeout);
  sandbox.stop();
});

test("idempotency: a repeated transactionId applies once at the operator", async () => {
  const { sandbox, client } = make(1000);
  const a = await client.bet(OP, req(100, "dup"));
  const b = await client.bet(OP, req(100, "dup"));
  expect(a.balance).toBe("900");
  expect(b.balance).toBe("900");
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(900n);
  sandbox.stop();
});

// F-001b/c TEETH: a stake ABOVE 2^53 minor units round-trips EXACT over the
// real HTTP wire. The amount AND the resulting balance are chosen so a JSON
// `number` cannot represent them — the pre-fix encoding (Math.trunc(res.balance) /
// numeric amount) would have silently corrupted them, so this test FAILS on the
// old `number` wire and PASSES only on the BigInt-safe decimal-string contract.
test("high-decimal: a >2^53 stake debits and the balance round-trips BigInt-exact over HTTP", async () => {
  const start = 10n ** 18n; // 1 ETH in wei — well above Number.MAX_SAFE_INTEGER
  const stake = 9n * 10n ** 17n + 1n; // 0.9 ETH + 1 wei → leaves an odd, non-double-representable balance
  const { sandbox, client } = make(0); // seed via the bigint-aware operator below
  sandbox.operator.seed("p1", "EUR", start);

  const expectedAfter = start - stake; // 99999999999999999n — NOT representable as a double
  // Guard the guard: confirm this value genuinely loses precision through a JS number,
  // i.e. the old `number` wire WOULD have corrupted it (so the assertions below have teeth).
  expect(BigInt(Math.trunc(Number(expectedAfter.toString())))).not.toBe(expectedAfter);

  const r = await client.bet(OP, req(stake, "hi1"));
  expect(r.balance).toBe(expectedAfter.toString()); // exact decimal string, no float rounding
  expect(BigInt(r.balance)).toBe(expectedAfter);
  // The operator booked EXACTLY the bigint stake (no 2^53 truncation on the way in).
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(expectedAfter);
  expect(expectedAfter).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  sandbox.stop();
});

test("unconfigured operator (no walletApiUrl) → OperatorError", async () => {
  const client = new HttpOperatorWalletApi(async () => ({ walletApiUrl: "", walletApiKey: null }));
  await expect(client.balance(OP, "p1", "EUR")).rejects.toBeInstanceOf(OperatorError);
});
