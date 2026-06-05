/**
 * Minimal stub operator seamless-wallet for LOAD testing (Phase 4.4).
 *
 * Settlement p99 < 200ms is an OPERATOR-MODE SLA — its real worst case is the
 * extra HTTP round-trip the SeamlessOperatorWallet makes to the operator wallet
 * on every debit/credit. The internal play-money ledger never makes that call,
 * so a number measured in `internal` mode flatters settlement. This stub is the
 * fast, well-behaved operator on the other end of that wire so we can measure
 * settlement under the realistic operator path.
 *
 * It speaks the exact protocol `HttpOperatorWalletApi` expects (see
 * src/wallet/http-operator-wallet.ts): POST JSON to `/{bet|win|rollback|balance}`,
 * `Authorization: Bearer <key>`, 200 → `{ operatorTxId, balance }`
 * (`{ balance }` for /balance), 402 → insufficient funds. Idempotent on
 * `transactionId` (a retry returns the same result, no re-apply) like a real
 * operator + the test MockOperator.
 *
 * This is the WELL-BEHAVED operator: it always answers fast with a 200. Failure
 * injection (delays, timeouts, 5xx, toxiproxy) belongs to the 4.5 reconciliation
 * soak — kept OUT of here so the settlement-latency run isn't polluted by faults.
 * (For that, point OPERATOR_WALLET_URL through toxiproxy at this stub.)
 *
 * Run (standalone):
 *   PORT=4001 WALLET_KEY=stub-key START_BALANCE=100000000 bun load/operator-wallet-stub.ts
 *
 * Then provision an Operator row whose walletApiUrl points here + boot the API in
 * operator mode (WALLET_PROVIDER_TYPE=operator + RISK_* env). See load/README.md.
 */

// Minimal ambient for Bun.serve — this script runs under `bun` (Bun is a runtime
// global). `load/` is outside the repo's tsc include (src/**), like the existing
// Bun.serve test helper; this keeps the file self-checking without adding @types/bun.
declare const Bun: {
  serve(opts: { port: number; fetch(req: Request): Response | Promise<Response> }): {
    port: number;
    stop(closeActive?: boolean): void;
  };
};

const PORT = Number(process.env.PORT ?? 4001);
const WALLET_KEY = process.env.WALLET_KEY ?? "stub-key";
// Default per-(player,currency) starting balance (minor units). Large so a long
// run of bets never runs a synthetic player dry mid-soak. A real operator tracks
// real money; this is a fixture.
const START_BALANCE = Number(process.env.START_BALANCE ?? 100_000_000);
// Optional fixed extra latency (ms) per money move — model a slow-but-healthy
// operator without faults. 0 = answer as fast as the loop allows.
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// player+currency → balance (minor units)
const balances = new Map<string, number>();
// transactionId → { operatorTxId, balance } (idempotent replay)
const applied = new Map<string, { operatorTxId: string; balance: number }>();
// transactionId → signed delta (for exact rollback)
const deltas = new Map<string, number>();

let opSeq = 0;
const counts = { bet: 0, win: 0, rollback: 0, balance: 0, dup: 0, insufficient: 0, unauthorized: 0 };

const key = (playerId: string, currency: string) => `${playerId}:${currency}`;

/** Apply a signed delta idempotently; returns the post-move balance. */
function apply(txId: string, playerId: string, currency: string, delta: number) {
  const dup = applied.get(txId);
  if (dup) { counts.dup++; return dup; }
  const k = key(playerId, currency);
  const before = balances.get(k) ?? START_BALANCE;
  const after = before + delta;
  if (after < 0) { counts.insufficient++; return null; } // insufficient funds
  balances.set(k, after);
  const res = { operatorTxId: `op-${++opSeq}`, balance: after };
  applied.set(txId, res);
  deltas.set(txId, delta);
  return res;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    // Bearer auth — mirror the operator contract (HttpOperatorWalletApi sends it
    // when a key is configured). Reject a wrong/missing key with 401.
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${WALLET_KEY}`) {
      counts.unauthorized++;
      return json({ error: "unauthorized" }, 401);
    }
    const path = new URL(req.url).pathname.replace(/^\/+/, "");
    const body = (await req.json().catch(() => ({}))) as any;
    if (LATENCY_MS > 0) await sleep(LATENCY_MS);

    if (path === "balance") {
      counts.balance++;
      const bal = balances.get(key(body.playerId, body.currency)) ?? START_BALANCE;
      return json({ balance: bal });
    }
    if (path === "bet") {
      counts.bet++;
      const r = apply(body.transactionId, body.playerId, body.currency, -Number(body.amount));
      return r ? json(r) : json({ error: "insufficient_funds" }, 402);
    }
    if (path === "win") {
      counts.win++;
      const r = apply(body.transactionId, body.playerId, body.currency, +Number(body.amount));
      return r ? json(r) : json({ error: "insufficient_funds" }, 402);
    }
    if (path === "rollback") {
      counts.rollback++;
      // Undo the named transaction if applied; idempotent on its own txId.
      const k = key(body.playerId, body.currency);
      const delta = deltas.get(body.transactionId);
      if (delta !== undefined && applied.has(body.transactionId)) {
        balances.set(k, (balances.get(k) ?? START_BALANCE) - delta);
        applied.delete(body.transactionId);
        deltas.delete(body.transactionId);
      }
      return json({ operatorTxId: `op-${++opSeq}`, balance: balances.get(k) ?? START_BALANCE });
    }
    return json({ error: `unknown_path_${path}` }, 404);
  },
});

console.log(`[operator-wallet-stub] listening on http://localhost:${server.port}`);
console.log(`  key=${WALLET_KEY}  startBalance=${START_BALANCE}  latencyMs=${LATENCY_MS}`);
console.log(`  endpoints: POST /bet /win /rollback /balance (Bearer auth)`);

// Periodic + on-exit counters so a soak run can confirm the operator saw the
// expected traffic (and how many idempotent replays happened).
const report = () =>
  console.log(`[operator-wallet-stub] counts=${JSON.stringify(counts)} players=${balances.size}`);
const interval = setInterval(report, 30_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(interval);
    report();
    server.stop(true);
    process.exit(0);
  });
}
