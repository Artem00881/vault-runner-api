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
 * WIRE CONTRACT (F-001b/c, F-078): `amount` IN and `balance` OUT are integer minor
 * units carried as BigInt-safe DECIMAL STRINGS — a single high-decimal-currency
 * value can exceed 2^53 (e.g. ETH at 18 dp), which a JSON `number` would silently
 * corrupt. This reference stub therefore keeps balances/deltas as `bigint`, parses
 * the inbound `amount` with `BigInt(...)`, and emits `balance` via `.toString()`,
 * exactly like the production `HttpOperatorWalletApi`/`SeamlessOperatorWallet` (and
 * the operator-facing `OperatorWalletApi` types). It NEVER does `Number(amount)`.
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

// `Bun` is the runtime global, typed by `bun-types` (tsconfig.scripts.json `types`).

const PORT = Number(process.env.PORT ?? 4001);
const WALLET_KEY = process.env.WALLET_KEY ?? "stub-key";
// Default per-(player,currency) starting balance (minor units), as a BigInt so it
// matches the on-the-wire decimal-string contract and never loses precision at high
// decimals. Large so a long run of bets never runs a synthetic player dry mid-soak.
// A real operator tracks real money; this is a fixture.
const START_BALANCE = BigInt(process.env.START_BALANCE ?? 100_000_000);
// Optional fixed extra latency (ms) per money move — model a slow-but-healthy
// operator without faults. 0 = answer as fast as the loop allows.
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// player+currency → balance (minor units, BigInt)
const balances = new Map<string, bigint>();
// transactionId → { operatorTxId, balance } (idempotent replay). `balance` is the
// already-stringified wire value so a replay returns byte-identical to the first apply.
const applied = new Map<string, { operatorTxId: string; balance: string }>();
// transactionId → signed delta (minor units, BigInt) for exact rollback
const deltas = new Map<string, bigint>();

// OPERATOR-BOOK reconciliation ledger, keyed by the server's betId (the seamless wallet
// sends `betId` on every bet/win/rollback — see seamless-operator-wallet.ts move()). This
// is the operator-side counterpart to the internal ledger: scripts/operator-recon-check.ts
// pulls it via GET /debug/book and cross-matches it against the DB's operator bets, so an
// OPERATOR-mode soak gets the same money-conservation gate the internal book gets from
// scripts/reconcile-check.ts. Per betId we track the net bet (debit), win (credit), and
// any rollback so the check can assert: every cashed_out op-bet got exactly one win, every
// busted op-bet got NO win, and Σ stake == Σ kept + Σ paid on the operator's own book.
// Book totals are BigInt minor units; the /debug/book dump stringifies them so the
// reconciliation checker parses them with BigInt (same wire discipline as money moves).
interface BookEntry { bet: bigint; win: bigint; rollback: bigint; player: string; currency: string }
const book = new Map<string, BookEntry>();
function bookEntry(betId: string, player: string, currency: string): BookEntry {
  let e = book.get(betId);
  if (!e) { e = { bet: 0n, win: 0n, rollback: 0n, player, currency }; book.set(betId, e); }
  return e;
}

let opSeq = 0;
const counts = { bet: 0, win: 0, rollback: 0, balance: 0, dup: 0, insufficient: 0, unauthorized: 0 };

const key = (playerId: string, currency: string) => `${playerId}:${currency}`;

/**
 * Apply a signed delta idempotently; returns the post-move result whose `balance`
 * is the BigInt-safe decimal STRING the wire carries (F-001b/c). A replay returns
 * the stored result unchanged.
 */
function apply(txId: string, playerId: string, currency: string, delta: bigint) {
  const dup = applied.get(txId);
  if (dup) { counts.dup++; return dup; }
  const k = key(playerId, currency);
  const before = balances.get(k) ?? START_BALANCE;
  const after = before + delta;
  if (after < 0n) { counts.insufficient++; return null; } // insufficient funds
  balances.set(k, after);
  const res = { operatorTxId: `op-${++opSeq}`, balance: after.toString() };
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

    if (req.method === "GET" && path === "debug/book") {
      // Operator-book dump for scripts/operator-recon-check.ts (Bearer-gated above).
      // betId → {bet,win,rollback,player,currency}; plus counts + balances summary.
      // Totals are BigInt minor units → stringify them (BigInt isn't JSON-serializable
      // and a Number would lose precision at high decimals), matching the money wire.
      const entries: Record<string, { bet: string; win: string; rollback: string; player: string; currency: string }> = {};
      for (const [betId, e] of book) {
        entries[betId] = { bet: e.bet.toString(), win: e.win.toString(), rollback: e.rollback.toString(), player: e.player, currency: e.currency };
      }
      return json({ counts, players: balances.size, book: entries });
    }
    if (path === "balance") {
      counts.balance++;
      const bal = balances.get(key(body.playerId, body.currency)) ?? START_BALANCE;
      return json({ balance: bal.toString() }); // F-001c: BigInt-safe decimal string
    }
    if (path === "bet") {
      counts.bet++;
      const amount = BigInt(body.amount); // F-001b: parse the decimal string with BigInt, never Number
      const fresh = !applied.has(body.transactionId);
      const r = apply(body.transactionId, body.playerId, body.currency, -amount);
      // Record on the operator book only on first apply (dup retries mustn't double-count).
      if (r && fresh && body.betId) bookEntry(body.betId, body.playerId, body.currency).bet += amount;
      return r ? json(r) : json({ error: "insufficient_funds" }, 402);
    }
    if (path === "win") {
      counts.win++;
      const amount = BigInt(body.amount); // F-001b: parse with BigInt
      const fresh = !applied.has(body.transactionId);
      const r = apply(body.transactionId, body.playerId, body.currency, amount); // win = credit (+amount)
      if (r && fresh && body.betId) bookEntry(body.betId, body.playerId, body.currency).win += amount;
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
        // Reflect the reversal on the operator book (the rolled-back debit no longer counts).
        if (body.betId && book.has(body.betId)) bookEntry(body.betId, body.playerId, body.currency).rollback += -delta;
      }
      return json({ operatorTxId: `op-${++opSeq}`, balance: (balances.get(k) ?? START_BALANCE).toString() }); // F-001c: decimal string
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
