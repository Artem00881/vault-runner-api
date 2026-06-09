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

| SLA | Target | Measured by | Status (local) |
|---|---|---|---|
| Settlement p99 | < 200 ms | `ws-load.ts AUTH_MODE=operator --scrape-metrics` → server-side `vaultrun_settlement_latency_ms` p99 (OPERATOR mode = HTTP wallet = worst case). | **MET** — p99 ≈ 25 ms operator-mode @ 40 clients |
| Concurrency | 10k WS / region | `ws-load.ts CLIENTS=10000` sharded across `WORKERS`/hosts; trust the server `vaultrun_ws_connections` gauge + flat memory + no tick starvation. | **INFRA-GATED** — needs multi-host generation (one box can't drive 10k cleanly) |
| Failover | < 5 s | `load/failover-drill.ts`: 2-node + Redis adapter, SIGKILL the leader mid-`running`, measure last-tick-before-kill → first-tick-after-resume (the inter-tick-gap hook). | **MET** — gap ≈ 1.6 s over 3 runs (SLA 5 s) |
| Reconciliation | 0 discrepancies / 1e6 rounds | `load/recon-soak.ts` (failure-injected, repeated leader SIGKILL) then `scripts/reconcile-check.ts`. | **MET (scaled)** — 0 discrepancies over failure-injected soaks; full 1e6 STAGING-GATED |

> The two MET-at-small-scale rows (settlement, reconciliation) and failover were
> **measured locally** (numbers in `4.5c.3 drill harness` below). 10k concurrency and the
> full 1e6-round soak are **infra-gated** — the harness is ready; they need a stable
> multi-host / long-running env (Docker Desktop here has ~30-60 s up-windows).

---

## 4.5c.3 drill harness — failover + operator-mode + reconciliation soak

> **Canonical failover record:** `load/CHAOS-FAILOVER.md` — the single reproducible
> write-up of the "failover < 5 s + 0-discrepancy" claim (exact local + at-scale commands,
> PASS criteria, the on-record staging numbers, and why this is a **manual multi-node run,
> not a single-node CI gate**).

Three dev-only tools (`load/`, run via `bun`; **typechecked in CI** via `tsconfig.scripts.json`,
but the multi-node *runs* below are manual — CI is single-node):

| Tool | Proves | One-liner |
|---|---|---|
| `load/failover-drill.ts` | failover < 5 s **and** seamless resume (not close+refund) | boots 2 nodes, SIGKILLs the leader mid-`running`, measures the tick gap + asserts the SAME round resumes + bets settle with 0 `restart_refund` |
| `load/recon-soak.ts` | 0 reconciliation discrepancies under repeated failover | boots 2 nodes, drives guest load, SIGKILL+respawns the leader on a cadence, asserts the soak adds 0 new discrepancies + absolute money-conservation holds |
| `ws-load.ts AUTH_MODE=operator` | settlement p99 in OPERATOR mode | each client launches as an operator player (launch-token → play-token) so settlement runs the HTTP wallet path |
| `load/cluster-harness.ts` | (shared) | node boot + leader mapping (`engine_leadership.node_id` ↔ child pid) + tracking client used by the soak |

**Failover drill** (2 local nodes share the dockerized pg+redis; both election-eligible):
```bash
DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
  REDIS_URL="redis://localhost:6379" JWT_SECRET=x GAME_CURRENCY=DEMO \
  CLIENTS=16 bun load/failover-drill.ts
# → ">> FAILOVER GAP (tick→tick): 1635ms  ✅ < SLA" + "seamless resume CONFIRMED"
```
Knobs: `PORT_A`/`PORT_B`, `CLIENTS`, `BET_RATE`, `KILL_AT_MULT` (kill once the running
multiplier crosses this), `FAILOVER_SLA_MS` (default 5000), `MAX_WAIT_MS`. **Both nodes
must stay election-eligible** — do NOT set `GAME_AUTOSTART=false` (that makes a node a
permanent follower → no survivor can take over). The leader is identified from the
authoritative `engine_leadership.node_id` (= `${HOSTNAME}-${pid}`), mapped to a child by pid.

**Reconciliation soak** (failure injection = repeated leader SIGKILL+respawn):
```bash
# DELTA mode (default): snapshots residuals first, asserts the soak adds 0 new ones
# (a long-lived dev DB carries constant orphan-ledger residuals that are NOT a leak —
#  see reconcile-check.ts §80; absolute checks 2 & 5 still assert outright).
DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
  REDIS_URL="redis://localhost:6379" JWT_SECRET=x GAME_CURRENCY=DEMO \
  ROUNDS=12 KILL_EVERY_MS=15000 bun load/recon-soak.ts

# PRISTINE mode: RESET_DB=1 TRUNCATEs the play tables first (DEV ONLY) for a clean
# canonical-gate PASS; follow with scripts/reconcile-check.ts.
RESET_DB=1 ROUNDS=8 KILL_EVERY_MS=18000 DATABASE_URL=… REDIS_URL=… JWT_SECRET=x \
  GAME_CURRENCY=DEMO bun load/recon-soak.ts && \
  DATABASE_URL=… bun scripts/reconcile-check.ts
```
Knobs: `ROUNDS` (stop after N completed), `MAX_MS`, `CLIENTS`, `BET_RATE`,
`CASHOUT_AT` (0 = ride to bust; >1 = auto-cashout, exercises the win→payout path),
`KILL_EVERY_MS` (0 disables kills), `RESET_DB`.

> The full **1e6-round** run is the SAME harness with a large `ROUNDS` + `KILL_EVERY_MS`,
> on a STABLE multi-node env (staging). Locally it runs at ~1 round / ~12 s with a kill
> ~every round; a 1e6 soak is a staging/CI long-run, not a laptop run.

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
| `CLIENTS` | 200 | total sockets across all workers (FIXED-N mode) |
| `WORKERS` | auto `min(CLIENTS, cpus, 8)` | generator worker threads (set `WORKERS=$(nproc)` per box) |
| `RAMP_TO` | 0 | **>0 ⇒ RAMP mode**: grow 0→`RAMP_TO` sockets over `RAMP_SECONDS`, then hold `DURATION_MS`. Prints a LIVE degradation series + a knee summary. `RAMP_TO` overrides `CLIENTS`. |
| `RAMP_SECONDS` | 120 | ramp duration (clients arrive ~linearly) |
| `SAMPLE_EVERY_MS` | 5000 | live-series cadence in RAMP mode (needs `--scrape-metrics` for the server cols) |
| `DURATION_MS` | 30000 | steady-state hold length (after the ramp, in RAMP mode) |
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
| `AUTH_MODE` | guest | `guest` (/api/auth/guest, internal wallet) or `operator` (launch-token → play-token, operator-wallet settlement path — the SLA worst case) |
| `OPERATOR_CODE` | — | operator `code` to launch under (AUTH_MODE=operator) |
| `OPERATOR_CURRENCY` | DEMO | currency for the operator launch (must be in `op.currencies`) |
| `PLAYER_PREFIX` | load | synthetic operator playerId prefix (`<prefix>-w<wkr>-<i>`) |

> `AUTH_MODE=operator` mints launch tokens IN the harness via `LaunchTokenService`
> (signs with the operator's `launchSecret` from the DB), so it needs `DATABASE_URL` +
> `JWT_SECRET` in its env too. Guest mode needs neither.

### Run commands
```bash
# Short baseline (internal mode), with server-side metrics:
BASE_URL=http://localhost:3001 CLIENTS=100 DURATION_MS=25000 BET_RATE=0.5 \
  CASHOUT_AT=1.3 SCRAPE_METRICS=1 bun load/ws-load.ts

# Exercise the manual cash_out ack leg (no auto-cashout):
CLIENTS=200 CASHOUT_AT=0 DURATION_MS=30000 bun load/ws-load.ts

# RAMP mode (calibration — find the per-node degradation knee). Grows 0→4000 over
# 5 min, holds 60s; prints a live ws_conn/p99/tickGap series + a knee verdict:
BASE_URL=http://<target>:3001 RAMP_TO=4000 RAMP_SECONDS=300 SAMPLE_EVERY_MS=5000 \
  DURATION_MS=60000 WORKERS=$(nproc) BET_RATE=0.2 CASHOUT_AT=1.3 \
  SCRAPE_METRICS=1 METRICS_TOKEN=loadtok bun load/ws-load.ts

# Concurrency push toward the 10k SLA (shard hard; ALWAYS across machines):
CLIENTS=10000 WORKERS=16 BET_RATE=0.2 DURATION_MS=60000 SCRAPE_METRICS=1 \
  AUTH_CONCURRENCY=100 bun load/ws-load.ts
```

> **CRITICAL — raise the throttle on the target.** The global per-IP rate limit
> (`THROTTLE_LIMIT`, default **120/min/IP**) will `429` a generator that opens
> thousands of guest auths from one IP (proven locally: 40 rapid `/api/auth/guest`
> → 40×429; with `THROTTLE_LIMIT=10000000` → 40×201). The load-box compose sets it
> to ~10M. Symptom if you forget: `authErrors` high, `connected ≪ CLIENTS`.

> A single host rarely sustains 10k active sockets cleanly — watch the SUSPECT
> flag and the loop-lag line. To truly hit 10k, run several copies on separate
> boxes pointed at the same target and **sum the server `ws_connections` gauge`**
> (ground truth), not the per-process client counters.

> **For the full multi-host Hetzner 10k run procedure, see [`RUN-10K.md`](./RUN-10K.md)**
> (box bootstrap via `hetzner-setup.sh`, calibration → cluster → failover/recon at
> scale → operator-mode settlement run, with exact commands + SLA pass/fail thresholds).

---

## Settlement-SLA run in OPERATOR mode (the real worst case)

The internal play-money ledger commits in-process; **operator mode adds an HTTP
round-trip per debit/credit** — that is the settlement SLA's worst case. Measure it
with the bundled stub operator wallet:

```bash
# 1) start the fast stub operator wallet
PORT=4001 WALLET_KEY=stub-key START_BALANCE=100000000 bun load/operator-wallet-stub.ts

# 2) provision an Operator row whose walletApiUrl = http://localhost:4001 and
#    walletApiKey = stub-key (currencies must include the launch currency):
DATABASE_URL=… JWT_SECRET=x bun scripts/operator-provision.ts \
  --code load-stub --name "Load Stub" --currencies DEMO \
  --wallet-url http://localhost:4001 --wallet-key stub-key

# 3) boot the API in operator mode with the REQUIRED risk ceilings. The boot guard
#    (assertRiskConfigForMode) FAILS CLOSED unless these EXACT keys are positive —
#    note RISK_MAX_MULTIPLIER / RISK_MAX_ROUND_EXPOSURE (NOT RISK_MULTIPLIER /
#    RISK_ROUND_EXPOSURE). METRICS_TOKEN locks /metrics (H5) — pass the same to the harness.
DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
  REDIS_URL="redis://localhost:6379" JWT_SECRET=x GAME_CURRENCY=DEMO \
  WALLET_PROVIDER_TYPE=operator METRICS_TOKEN=loadtok \
  RISK_MAX_WIN_PER_BET=100000000 RISK_MAX_MULTIPLIER=10000 \
  RISK_MAX_ROUND_EXPOSURE=1000000000 RISK_MAX_BET=1000000 \
  bun run src/main.ts

# 4) run the harness in OPERATOR auth mode (now built — each client launches as an
#    operator player) and read the SERVER-side settlement p99:
DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
  REDIS_URL="redis://localhost:6379" JWT_SECRET=x GAME_CURRENCY=DEMO \
  BASE_URL=http://localhost:3001 AUTH_MODE=operator OPERATOR_CODE=load-stub \
  OPERATOR_CURRENCY=DEMO CLIENTS=40 DURATION_MS=45000 BET_RATE=0.7 CASHOUT_AT=1.3 \
  SCRAPE_METRICS=1 METRICS_TOKEN=loadtok bun load/ws-load.ts
# Confirm the operator path was actually hit: the stub logs counts={"bet":N,"win":M,...}.
```

**Measured locally (40 clients, operator mode):** server-side settlement
`p99 ≈ 25 ms` (p50 ≈ 10 ms) — the stub confirmed `bet:78 win:52` so the HTTP wallet
path WAS exercised. Verdict: settlement p99 is **MET in operator mode at this scale**
(25 ms ≪ 200 ms). Re-measure at higher concurrency on staging; if horizontal
scaling/tuning ever can't meet it, the documented risk-gate is to rewrite ONLY the hot
path (engine + gateway) in Go, contracts unchanged — flag for sign-off.

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
out-of-scope-here — never silently passed. Invariants 2 and 5 are mode-agnostic.

**Operator-book reconciliation — `scripts/operator-recon-check.ts` (NEW).** The
operator-mode counterpart: it pulls the stub operator wallet's book (the new
bearer-gated `GET /debug/book` on `operator-wallet-stub.ts`, keyed by the server
`betId` the seamless wallet sends on every move) and cross-matches it against our
`game_bets` where `operatorId IS NOT NULL`. Invariants: **O1** every `cashed_out`
op-bet has exactly one operator `win` == `payout`; **O2** no `busted` op-bet got a
win; **O3** every wagered op-bet has a `bet` debit == stake (net of rollback); **O4**
no op-bet stuck in `reserving|cancelling|payout_pending`; **O5** book conservation
`Σbet − Σwin − Σrollback == Σstake(wagered) − Σpayout(cashed)`. Run it AFTER an
operator-mode soak, BEFORE the stub restarts (its book is in-memory; for a real
operator the equivalent input is the operator's transaction statement):
```bash
DATABASE_URL=… STUB_URL=http://localhost:4001 STUB_KEY=stub-key OPERATOR_CODE=load-stub \
  bun scripts/operator-recon-check.ts
```
> The op-book check needs a stub instance whose in-memory book covers ALL the op-bets
> being checked — do NOT restart the stub mid-run, and start from a clean op-bet slate
> (a stale DB + fresh stub shows false "missing-debit/missing-win" for the pre-restart bets).

The full failure-injected 1e6-round soak that EXERCISES the recovery paths (kill
nodes, toxiproxy the operator wallet to force `payout_pending`, strand `reserving`)
is the multi-host run in **`RUN-10K.md`**; these two checks are what you run against
the resulting DB (internal book) + operator book.

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
     `recoverInterruptedRounds`/`resumeOrRecover` handles in-flight bets (no double-pay).
   - **Engine leader SIGKILL:** now AUTOMATED — `load/failover-drill.ts` (see the
     "4.5c.3 drill harness" section above) boots a 2-node cluster + Redis adapter +
     leader election, SIGKILLs the leader mid-`running`, measures the inter-tick gap
     and asserts the round RESUMED (4.5c.2) with 0 `restart_refund`. For sustained
     chaos + reconciliation, use `load/recon-soak.ts`.
3. Record time-to-recover. Target: failover <5s, no money discrepancy. **Measured
   locally: ~1.6 s gap, 0 discrepancies** (see the drill-harness section).
