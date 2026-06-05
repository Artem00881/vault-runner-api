# Load, latency & chaos testing

Two layers:

1. **HTTP/REST surface** — k6 scenarios (`k6-*.js`), Phase 1.
2. **WebSocket hot path (the money path)** — `ws-load.ts`, the Phase-4.4 sharded
   Socket.IO latency harness that measures the Phase-4 SLAs.

Run against **staging** or a **local** instance, **never the live demo DB** — the
guest-auth flow creates real rows. For local: `docker compose up -d postgres redis`,
`docker stop vaultrun-api`, free `:3001` (`lsof -ti:3001 | xargs kill -9`), then boot
with inline env (zsh won't word-split `env $VAR`):

```bash
DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
  REDIS_URL="redis://localhost:6379" JWT_SECRET=x GAME_CURRENCY=DEMO \
  bun run src/main.ts
```

Always confirm you're hitting the server you think (`curl /health`) and the engine
is cycling before trusting a number.

---

## Phase-4 SLAs and how each is measured

| SLA | Target | Measured by | Status |
|---|---|---|---|
| Settlement p99 | < 200 ms | `ws-load.ts --scrape-metrics` → server-side `vaultrun_settlement_latency_ms` p99. **Must be run in OPERATOR mode** (HTTP wallet = worst case). | this harness |
| Concurrency | 10k WS / region | `ws-load.ts CLIENTS=10000` sharded across `WORKERS`; trust the server `vaultrun_ws_connections` gauge + flat memory + no tick starvation. | this harness |
| Failover | < 5 s | inter-tick-gap tracking here + the 4.5 2-node/Redis-adapter SIGKILL drill (last tick before kill → first tick after promote). | 4.5 |
| Reconciliation | 0 discrepancies / 1e6 rounds | `scripts/reconcile-check.ts` after a failure-injected soak. | `reconcile-check.ts` (gate); 1e6 soak in 4.5 |

---

## WebSocket harness — `load/ws-load.ts`

A custom `socket.io-client` harness (we already depend on it; full control of the
phase-driven flow: auth → wait for `betting` → `place_bet` → time the ack → on
crash, time `bet_busted`). It shards generators across **worker_threads** because
one event loop can't actively drive ~10k sockets without the *generator* becoming
the bottleneck — each worker self-monitors event-loop lag and marks the run
**suspect** if its loop is starved (so a bad generator can't masquerade as a server
SLA failure).

**Client numbers are a lower bound** (client + network + server). For the real
settlement SLA, pass `--scrape-metrics` to also read the **server-side** histogram
p99 and `ws_connections` gauge — that is the ground truth.

### What it reports
- Per-action client latency percentiles (p50/p95/p99/max) for `place_bet`,
  `cash_out`, `bet_busted`, via compact mergeable histograms (bucket-upper-bound
  estimates, conservative for an SLA).
- Inter-tick gap distribution + max (tick starvation now; the **failover window**
  in 4.5 — a long gap straddling a leader SIGKILL).
- Socket/bet/cashout/bust counts, reject-reason breakdown, ack timeouts.
- Generator health (worker loop-lag max; SUSPECT flag).
- With `--scrape-metrics`: server-side settlement p50/p95/p99, observation delta,
  `ws_connections` gauge vs client-connected, `rounds_total`/`cashouts_total`.

### Latency definitions
- **place_bet / cash_out** — `emit` → socket.io ack callback (the gateway handler
  returns the result to the ack). True request→response.
- **bet_busted** — `round_crashed` seen for our round → `bet_busted` push received.
  This is the settlement **fan-out** leg (crash → ledger commit → client notify).
- Server-side **settlement_latency** (the SLA metric) is observed inside the server
  on BOTH legs (decision §2 Option A): `cashOut` confirmed-credit, and `settleRound`
  on crash. Read it via `--scrape-metrics`.

### Knobs (env)
| Var | Default | Meaning |
|---|---|---|
| `BASE_URL` | `http://localhost:3001` | API base |
| `CLIENTS` | 200 | total sockets across all workers |
| `WORKERS` | auto `min(CLIENTS, cpus, 8)` | generator worker threads |
| `DURATION_MS` | 30000 | steady-state run length |
| `BET_RATE` | 0.5 | fraction of clients betting each window |
| `BET_AMOUNT` | 50 | stake (minor units) |
| `CASHOUT_AT` | 1.5 | auto-cashout target; `<=1` ⇒ manual cash-out at 1.2x (exercises the cash_out ack leg) |
| `ACK_TIMEOUT_MS` | 5000 | per-action socket.io ack timeout |
| `AUTH_CONCURRENCY` | 50 | max in-flight guest-auth per worker (ramp) |
| `RAW_SAMPLES` | 0 | keep N raw samples per action (debug) |
| `SCRAPE_METRICS` | 0 | `1`/`--scrape-metrics` ⇒ read `/metrics` at start+end |
| `METRICS_TOKEN` | — | bearer for `/metrics` if locked (H5) |
| `LAG_WARN_MS` | 50 | per-worker loop-lag warn threshold |
| `TICK_GAP_WARN_MS` | 1000 | inter-tick-gap warn threshold |

### Run commands
```bash
# Short baseline (internal mode), with server-side metrics:
BASE_URL=http://localhost:3001 CLIENTS=100 DURATION_MS=25000 BET_RATE=0.5 \
  CASHOUT_AT=1.3 SCRAPE_METRICS=1 bun load/ws-load.ts

# Exercise the manual cash_out ack leg (no auto-cashout):
CLIENTS=200 CASHOUT_AT=0 DURATION_MS=30000 bun load/ws-load.ts

# Concurrency push toward the 10k SLA (shard hard; ideally across machines):
CLIENTS=10000 WORKERS=16 BET_RATE=0.2 DURATION_MS=60000 SCRAPE_METRICS=1 \
  AUTH_CONCURRENCY=100 bun load/ws-load.ts
```

> A single host rarely sustains 10k active sockets cleanly — watch the SUSPECT
> flag and the loop-lag line. To truly hit 10k, run several copies on separate
> boxes pointed at the same target and **sum the server `ws_connections` gauge**
> (ground truth), not the per-process client counters.

---

## Settlement-SLA run in OPERATOR mode (the real worst case)

The internal play-money ledger commits in-process; **operator mode adds an HTTP
round-trip per debit/credit** — that is the settlement SLA's worst case. Measure it
with the bundled stub operator wallet:

```bash
# 1) start the fast stub operator wallet
PORT=4001 WALLET_KEY=stub-key bun load/operator-wallet-stub.ts

# 2) provision an Operator row whose walletApiUrl = http://localhost:4001 and
#    walletApiKey = stub-key  (scripts/operator-provision.ts), then mint a launch
#    token (scripts/operator-launch-token.ts). The harness currently auths as a
#    GUEST (internal wallet); an operator-token mode for ws-load.ts is a small
#    follow-up — until then, drive operator settlement via an operator-token client
#    and read server-side settlement p99 from --scrape-metrics.

# 3) boot the API in operator mode with the REQUIRED risk env (boot fails closed
#    otherwise — RISK_* must be positive):
DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
  REDIS_URL="redis://localhost:6379" JWT_SECRET=x GAME_CURRENCY=DEMO \
  WALLET_PROVIDER_TYPE=operator \
  RISK_MAX_WIN_PER_BET=100000000 RISK_MULTIPLIER=10000 \
  RISK_ROUND_EXPOSURE=1000000000 RISK_MAX_BET=1000000 \
  bun run src/main.ts

# 4) run ws-load.ts --scrape-metrics and read SERVER-side settlement p99.
```

State the verdict plainly: settlement p99 is **MET / NOT MET at N concurrency in
operator mode**. If horizontal scaling/tuning can't meet it, the documented
risk-gate is to rewrite ONLY the hot path (engine + gateway) in Go, contracts
unchanged — flag for sign-off.

---

## Reconciliation gate — `scripts/reconcile-check.ts`

Read-only ledger-vs-bets assertion (SLA #4). Run AFTER a soak:

```bash
DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
  bun scripts/reconcile-check.ts
```

Invariants: (1) Σ debited == Σ credited + Σ kept; (2) per-wallet latest
`balanceAfter` == `wallet.balance`; (3) every `cashed_out` win has a matching
payout ledger row + `payoutTxId`; (4) no `busted` bet was paid; (5) `reserving`/
`cancelling` and `payout_pending` backlogs are 0. Exits non-zero on any
discrepancy (CI/soak-gate friendly).

**Mode-aware scope:** the internal ledger (`ledger_transactions`) is written ONLY
for internal/guest play, so the ledger-conservation invariants (1, 3, 4) are scoped
to `operatorId IS NULL` and validate the **internal book**. Operator-mode bets keep
their book on the operator side (no ledger rows) and are reported as
out-of-scope-here — never silently passed; their reconciliation against the operator
statement is the **4.5** operator-soak's job. Invariants 2 and 5 are mode-agnostic.
The full failure-injected 1e6-round soak that EXERCISES the recovery paths (kill
nodes, toxiproxy the operator wallet to force `payout_pending`, strand `reserving`),
plus the operator-token client for `ws-load.ts` (it auths as a guest today), are
driven in **4.5**; this is the check you run against the resulting DB.

---

## HTTP/REST scenarios (k6, Phase 1)

| Script | Shape | Gate |
|---|---|---|
| `k6-http.js` | ramp 0→VUS→0 | `http_req_failed`<1%, read `p95<200ms` / `p99<500ms` |
| `k6-spike.js` | sudden surge to PEAK, recover | `http_req_failed`<2%, `p95<500ms` |

Flow per VU: public reads (`/health`, `/api/fairness/current`,
`/api/round/current`, `/api/leaderboard`) + one guest auth (`POST /api/auth/guest`)
+ an authed read (`/api/wallet/balance`). k6 does **not** speak Socket.IO — the WS
hot path is covered by `ws-load.ts` above.

**Run (Docker, no install):**
```bash
# macOS/Windows: reach the host API via host.docker.internal
docker run --rm -e BASE_URL=http://host.docker.internal:3001 \
  -v "$PWD/load:/load" grafana/k6 run /load/k6-http.js
# Linux: --network host + localhost
docker run --rm --network host -e BASE_URL=http://localhost:3001 \
  -v "$PWD/load:/load" grafana/k6 run /load/k6-http.js
```
**Local k6** (`brew install k6`): `BASE_URL=… k6 run load/k6-http.js`.
Tunables: `BASE_URL`, `VUS`, `RAMP`, `HOLD` (k6-http); `PEAK` (k6-spike).

---

## Chaos / failover (manual procedure — full drill in 4.5)

k6 (or `ws-load.ts`) generates load; you inject the failure and watch recovery via
`/health` (deep DB+Redis) and `/metrics` (RTP, error counters, backlog gauges).

1. Start a steady load.
2. Mid-run, kill a dependency:
   - **Redis down:** `docker stop vaultrun-redis` → `/health` flips 503; restart recovers.
   - **Postgres down:** `docker stop vaultrun-postgres` → 503; restart recovers.
   - **API restart (engine recovery):** `docker restart vaultrun-api` → on boot
     `recoverInterruptedRounds` refunds in-flight bets (no double-refund).
   - **Engine leader SIGKILL (4.5):** 2-node cluster + Redis adapter + leader
     election; `docker kill` the leader mid-round; measure the inter-tick gap
     (`ws-load.ts` already timestamps every `multiplier_update`) and assert
     `reconcile-check.ts` shows 0 money discrepancies across the gap.
3. Record time-to-recover. Target: failover <5s, no money discrepancy.
