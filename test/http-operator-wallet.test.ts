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
const req = (amount: number, id: string) => ({
  playerId: "p1",
  currency: "EUR",
  amount,
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
  expect(r.balance).toBe(900);
  expect(typeof r.operatorTxId).toBe("string");
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(900);
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
  expect(r.balance).toBe(1250);
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(1250);
  sandbox.stop();
});

test("balance() reads through to the operator", async () => {
  const { sandbox, client } = make(777);
  expect(await client.balance(OP, "p1", "EUR")).toBe(777);
  sandbox.stop();
});

test("insufficient funds (HTTP 402) → OperatorInsufficientFunds", async () => {
  const { sandbox, client } = make(50);
  await expect(client.bet(OP, req(100, "t1"))).rejects.toBeInstanceOf(OperatorInsufficientFunds);
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(50);
  sandbox.stop();
});

test("operator 500 → OperatorError", async () => {
  const { sandbox, client } = make(1000);
  sandbox.arm({ status: 500 });
  await expect(client.bet(OP, req(100, "t1"))).rejects.toBeInstanceOf(OperatorError);
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(1000);
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
  expect(a.balance).toBe(900);
  expect(b.balance).toBe(900);
  expect(sandbox.operator.balanceOf("p1", "EUR")).toBe(900);
  sandbox.stop();
});

test("unconfigured operator (no walletApiUrl) → OperatorError", async () => {
  const client = new HttpOperatorWalletApi(async () => ({ walletApiUrl: "", walletApiKey: null }));
  await expect(client.balance(OP, "p1", "EUR")).rejects.toBeInstanceOf(OperatorError);
});
