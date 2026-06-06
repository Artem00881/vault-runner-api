# RUN-10K — the Phase 4.5c.3 10k SLA load test on Hetzner

The step-by-step runbook for the last unmeasured Phase-4 SLA (**10k concurrent
connections / region**) plus the at-scale re-measurement of settlement p99,
failover, and the 1e6-round reconciliation soak. Closes the Go-vs-NestJS rewrite
**risk gate** and sizes the multi-node prod infra.

> **Read first:** [`README.md`](./README.md) (harness internals + knobs). All commands
> use `bun` directly (`load/` + `scripts/` are outside the tsc CI typecheck).
> **The boxes are provisioned + paid by the user** — this runbook assumes you have SSH
> to fresh **Ubuntu 24.04** Hetzner boxes and their **private** IPs.

## TL;DR of what's validated locally (so you know what to expect)
Everything below was smoke-tested locally against `a180a45` before the run:
- RAMP mode + live degradation series + knee summary — **works** (clean ramp to 600,
  ws_conn tracks launched, server p99 25ms throughout).
- `--scrape-metrics` reads `vaultrun_settlement_latency_ms` p99 + the
  `vaultrun_ws_connections` gauge (the honest concurrency number) — **works**.
- `AUTH_MODE=operator` end-to-end (launch-token → play-token → operator HTTP wallet
  settlement) — **works** (stub confirmed `bet:N win:N`, server p99 25ms operator-mode).
- `hetzner-setup.sh target` image build from the tree — **builds clean**.
- `operator-recon-check.ts` (operator-book conservation) — **PASS on a coherent dataset**.

The ONLY thing that genuinely needs the boxes: the at-scale numbers (one laptop +
local server can't honestly drive 10k or sustain a multi-hour soak).

---

## 0. Hard requirements (don't skip — they make the numbers trustworthy)
- **DEDICATED vCPU** for the TARGET (CCX-line). Shared vCPU (the 2-vCPU staging box)
  is too noisy for a trustworthy p99.
- **Generators on SEPARATE hosts** from the target. You cannot self-generate 10k
  honestly (the generator competes with the server for the same cores). Local Docker
  and the 2-vCPU staging box are BOTH inadequate.
- **Private networking** between target + generators (Hetzner Cloud private network).
  Point the harness at the target's **private** IP, not the public one.
- **Raise the throttle on the target** (the load-box compose does this:
  `THROTTLE_LIMIT=10000000`). The prod default 120/min/IP will `429` a generator's
  guest-auth burst.
- **Sum the server gauge, not client counters.** `vaultrun_ws_connections` from
  `/metrics` is ground truth; per-process client `connected` is a lower bound.

## SLA pass/fail thresholds (the acceptance criteria)
| SLA | Threshold | Source of truth |
|---|---|---|
| Settlement p99 | **< 200 ms** | server `vaultrun_settlement_latency_ms` p99, **OPERATOR mode** (HTTP wallet = worst case) |
| Concurrency | **10 000** live WS / region | server `vaultrun_ws_connections` gauge summed across generators, with no tick starvation + flat memory |
| Failover | **< 5 s** | `failover-drill.ts` tick-gap (last tick before SIGKILL → first tick after resume), **0** money discrepancies across the gap |
| Reconciliation | **0** discrepancies / 1e6 rounds | `reconcile-check.ts` (internal) + `operator-recon-check.ts` (operator) after the failure-injected soak |

> **Histogram resolution caveat:** the server settlement histogram buckets are
> `10/25/50/100/200/500/1000` ms. Near the SLA the finest readings are **100** and
> **200**. A reported p99 of `100` means "≤100ms" (comfortably MET); a p99 of `200`
> means "≤200ms" (MET but at the bucket edge — capture the `_sum/_count` mean too and
> note it). A p99 of `500` is NOT MET. If you need finer resolution right at 200ms,
> that's a one-line bucket change in `metrics.service.ts` (deploy-gated; flag it).

---

## 1. Box plan (create → run → destroy; ~€1–2/run on hourly billing)

### Step 1 — calibration (find capacity/node)
| Box | Type | Role |
|---|---|---|
| target-1 | **CCX33** (8 dedicated vCPU / 32 GB) | postgres+redis+api on the pinned commit |
| gen-1 | **CCX23** (4 dedicated vCPU / 16 GB) | drives `ws-load.ts` RAMP |

### Step 2 — honest 10k (from the calibration capacity)
| Box | Type | Role |
|---|---|---|
| node-1, node-2 | **CCX23** ×2 | API nodes behind a LB (Redis adapter fans ticks) |
| db | dedicated/managed Postgres + Redis | shared backing store |
| gen-1..gen-3 | **CCX23** ×2–3 | each drives ~3–5k clients (sum the gauge) |

> Size node count from Step 1: **nodes ≳ ceil(10000 / last-healthy-ws_conn-per-node)**,
> then add headroom + one node for the failover drill. The RAMP knee summary prints
> this hint at the end of the calibration run.

---

## 2. Bootstrap (both code-delivery methods work)

`hetzner-setup.sh` auto-detects whether the tree is a git checkout (it will
`git checkout $PIN_COMMIT`, default `6bfda18`, so the measured build matches prod) or
an rsync'd tree (measures as-is). Docker CLI on macOS:
`export PATH="$PATH:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin"`.

**Deliver the code to a box (pick one):**
```bash
# git (preferred — pins the commit automatically)
ssh root@<box> 'git clone <repo-url> vault-runner-api'
# rsync (no .git → pass PIN_COMMIT='' on the box to measure HEAD as delivered)
rsync -az --exclude node_modules --exclude .git ./ root@<box>:/root/vault-runner-api/
```

**TARGET box (internal/guest mode — for concurrency + failover + internal soak):**
```bash
ssh root@<target-1>
cd vault-runner-api
bash load/hetzner-setup.sh target
#  → installs Docker, checks out 6bfda18, brings up postgres+redis+api (TEST env,
#    engine autostart on, /metrics open with METRICS_TOKEN=loadtok, THROTTLE_LIMIT=10M),
#    binds the API on the PRIVATE IP, prints the reachable URL + the engine-leader log.
curl -s http://localhost:3001/health      # confirm {"status":"ok"} ON THE BOX
```

**GENERATOR box(es):**
```bash
ssh root@<gen-1>
cd vault-runner-api
bash load/hetzner-setup.sh generator      # installs Bun + repo deps (no API)
# sanity: confirm it can reach the target's PRIVATE IP
curl -s http://<TARGET_PRIVATE_IP>:3001/health
```

---

## 3. Step 1 — CALIBRATION ramp (capacity/node)

From **gen-1**, ramp until the knee. Start with a generous ceiling; the run stops at
`RAMP_TO` or when you see the degradation inflection in the live series.

```bash
# on gen-1, in vault-runner-api/
BASE_URL=http://<TARGET_PRIVATE_IP>:3001 \
  RAMP_TO=8000 RAMP_SECONDS=600 SAMPLE_EVERY_MS=5000 DURATION_MS=120000 \
  WORKERS=$(nproc) BET_RATE=0.2 CASHOUT_AT=1.3 AUTH_CONCURRENCY=100 \
  SCRAPE_METRICS=1 METRICS_TOKEN=loadtok \
  bun load/ws-load.ts | tee /tmp/calib-$(date +%s).log
```

**What to watch in the LIVE series (printed every 5s):**
```
   t(s)  wsConn  launch  cliP99  srvP99  tickGap  lag  accept%  note
```
- `wsConn` (server gauge) should track `launch` closely. If `wsConn ≪ launch` →
  the target is dropping/refusing sockets (a real ceiling) OR the generator is the
  bottleneck (check `lag` + the SUSPECT note).
- **The KNEE** = the first sample where any of: `srvP99 > 200`, `tickGap` >
  `TICK_GAP_WARN_MS` (1000; this is the **same-round** mid-flight gap — between-round
  gaps are excluded), `accept% < 98`, or the generator goes SUSPECT.
- The end-of-run **RAMP DEGRADATION SUMMARY** prints `last HEALTHY ws_conn` (the
  conservative per-node ceiling) and classifies the knee as **SERVER-side** (real
  capacity signal) or **GENERATOR-side** (re-run with more `WORKERS` / more gen boxes —
  the true server knee is higher).

**Capture:** `last-healthy ws_conn` (capacity/node), the `srvP99` at that point, peak
memory on the target (`ssh <target> 'docker stats --no-stream vaultrun-api'`), and
whether the knee was server- or generator-side.

> If one gen-1 box can't push past its OWN loop (SUSPECT before the server bends), add
> gen boxes NOW and split `RAMP_TO` across them (each box runs its own ramp; sum the
> single server gauge). The server gauge is the same number regardless of how many
> generators feed it.

---

## 4. Step 2 — HONEST 10k (concurrency SLA)

Stand up the cluster sized from Step 1. Each API node is its own `target` box pointed
at the **shared** Postgres + Redis (so the Redis adapter fans ticks across nodes and
all nodes share one engine-leader election).

### 4a. Shared backing store
Use a managed/dedicated Postgres + Redis (or one small box running just
`docker compose -f docker-compose.yml up -d postgres redis`). Note its private IP.

### 4b. API nodes (×N, behind a LB)
On each node box, bring up ONLY the API pointed at the shared store. Easiest: edit
`load/.env.loadtest` to point `DATABASE_URL`/`REDIS_URL` at the shared store, OR run
the api container directly:
```bash
# on each node box (after `hetzner-setup.sh target` built the image once):
docker run -d --name vaultrun-api -p <NODE_PRIVATE_IP>:3001:3001 \
  -e DATABASE_URL="postgresql://vault:vault@<DB_PRIVATE_IP>:5432/vaultrun?schema=public" \
  -e REDIS_URL="redis://<REDIS_PRIVATE_IP>:6379" \
  -e JWT_SECRET=loadtest-jwt-secret -e GAME_CURRENCY=DEMO \
  -e METRICS_TOKEN=loadtok -e THROTTLE_LIMIT=10000000 \
  vaultrun-api-loadtest:smoke   # or the image tag the compose built
```
Put the nodes behind a Hetzner LB (TCP/WS, sticky not required — the Redis adapter
makes any node serve any client). **Exactly one** node will log `acquired leadership`
+ `Game engine started`; the rest are followers serving WS. Confirm:
```bash
for n in <NODE1_IP> <NODE2_IP>; do echo "== $n =="; ssh root@$n 'docker logs vaultrun-api 2>&1 | grep -iE "acquired leadership|engine started" | tail -2'; done
```

### 4c. Drive 10k from the generators
Split the target across gen boxes so each drives ~3–5k (under its measured per-box
ceiling from Step 1). Point them all at the **LB** address.
```bash
# on EACH gen box (adjust CLIENTS per box so the SUM = 10000+ and each ≤ its ceiling):
BASE_URL=http://<LB_PRIVATE_IP>:3001 \
  CLIENTS=4000 WORKERS=$(nproc) BET_RATE=0.2 CASHOUT_AT=1.3 \
  DURATION_MS=300000 AUTH_CONCURRENCY=120 \
  SCRAPE_METRICS=1 METRICS_TOKEN=loadtok \
  bun load/ws-load.ts | tee /tmp/10k-gen$(hostname)-$(date +%s).log
```
Each gen process scrapes the LB `/metrics` — but behind a LB that hits ONE node's
gauge. **For the true total, scrape EVERY node and sum** (the gauge is per-node):
```bash
# from anywhere with private-net access, while the run is at peak:
total=0; for n in <NODE1_IP> <NODE2_IP>; do
  v=$(curl -s -H "authorization: Bearer loadtok" http://$n:3001/metrics | awk '/^vaultrun_ws_connections /{print $2}');
  echo "$n: $v"; total=$(echo "$total + $v" | bc); done; echo "TOTAL ws_connections = $total"
```

**PASS:** summed `ws_connections ≥ 10000`, every node's settlement p99 < 200ms,
tick cadence steady (no node's clients see a sustained same-round gap), memory flat
(re-check `docker stats` after a few minutes — no upward creep = no leak).

> **Concurrency vs settlement-mode:** this 10k concurrency run can be INTERNAL mode
> (it's about socket fan-out + tick delivery, not the wallet path). The settlement-p99
> SLA's worst case is OPERATOR mode — measure that separately in §6 (it doesn't need
> 10k to be the worst case; the HTTP wallet round-trip is, and you measure p99 under a
> realistic betting fraction).

---

## 5. Failover < 5s + reconciliation soak (at scale)

These are **already PROVEN on staging** (failover gaps 486–1550ms over 31 rounds / 38
SIGKILLs, reconcile RECONCILED/0). Re-run at scale on the cluster to confirm under load.

### 5a. Failover drill (2 nodes + the shared store)
The drill spawns its OWN two `bun run src/main.ts` nodes against the store you point it
at. Run it ON a node box (it needs the repo + DATABASE_URL/REDIS_URL to the shared store):
```bash
DATABASE_URL="postgresql://vault:vault@<DB_PRIVATE_IP>:5432/vaultrun?schema=public" \
  REDIS_URL="redis://<REDIS_PRIVATE_IP>:6379" JWT_SECRET=loadtest-jwt-secret GAME_CURRENCY=DEMO \
  CLIENTS=40 KILL_AT_MULT=1.2 FAILOVER_SLA_MS=5000 \
  bun load/failover-drill.ts
# PASS: ">> FAILOVER GAP (tick→tick): <5000ms ✅ < SLA" AND "seamless resume CONFIRMED"
#       (0 restart_refund rows, ride-through bets settled cashed_out|busted).
```
Optionally drive background load from a gen box at the same time (point `ws-load.ts` at
those two nodes) so the failover is measured UNDER load, not idle.

### 5b. Reconciliation soak (failure-injected, internal book)
```bash
# big run on a STABLE box (the soak repeatedly SIGKILL+respawns the leader):
DATABASE_URL=… REDIS_URL=… JWT_SECRET=loadtest-jwt-secret GAME_CURRENCY=DEMO \
  ROUNDS=100000 MAX_MS=86400000 CLIENTS=60 BET_RATE=0.7 CASHOUT_AT=0 \
  KILL_EVERY_MS=15000 bun load/recon-soak.ts
# then the canonical gate against the resulting DB:
DATABASE_URL=… bun scripts/reconcile-check.ts
# PASS: "RECONCILED — 0 money discrepancies".
```
> The "1e6 rounds" target is the same harness with a large `ROUNDS` over a long
> window (a 1e6-round soak is a multi-hour/multi-day long-run, not a single session —
> raise `ROUNDS` + `MAX_MS` and let it run; the assertions are identical at any scale).
> For a pristine baseline use `RESET_DB=1` (DEV ONLY — TRUNCATEs the play tables).

---

## 6. Operator-mode settlement-p99 run (the SLA worst case)

The internal ledger commits in-process; operator mode adds an **HTTP round-trip per
debit/credit** — that is the settlement SLA's worst case. Use a `target-op` box.

```bash
# 1) bring the target up in OPERATOR mode + stub wallet + provisioned operator row:
ssh root@<target-op>
cd vault-runner-api && bash load/hetzner-setup.sh target-op
#  → API in WALLET_PROVIDER_TYPE=operator with the RISK_* ceilings, the stub wallet on
#    :4001, and the `load-stub` Operator row pointing at it (walletApiUrl=host gateway).

# 2) drive the operator-mode harness. It MINTS launch tokens itself via LaunchTokenService
#    → it needs DATABASE_URL to THIS box's postgres + the same JWT_SECRET. Two options:
#    (a) run the harness ON the target box (localhost pg), or
#    (b) expose pg to the gen box + pass its DATABASE_URL. (a) is simplest:
DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
  REDIS_URL="redis://localhost:6379" JWT_SECRET=loadtest-jwt-secret GAME_CURRENCY=DEMO \
  BASE_URL=http://localhost:3001 AUTH_MODE=operator OPERATOR_CODE=load-stub \
  OPERATOR_CURRENCY=DEMO CLIENTS=2000 DURATION_MS=180000 BET_RATE=0.7 CASHOUT_AT=1.3 \
  SCRAPE_METRICS=1 METRICS_TOKEN=loadtok \
  bun load/ws-load.ts | tee /tmp/op-settlement-$(date +%s).log

# 3) confirm the operator HTTP path was ACTUALLY exercised (else the number is meaningless):
cat /tmp/op-wallet-stub.log | tail -3   # expect counts={"bet":N,"win":M,...} with N,M>0
```
**PASS:** the SERVER-side `settlement_latency_ms` p99 < 200ms in the harness output
(labeled "operator-mode … assert it against 200ms"), AND the stub shows non-zero
`bet`/`win` counts. THIS is the headline settlement-SLA number.

> Settlement p99 is a per-event latency, not a 10k-concurrency property — a few
> thousand betting clients on a `target-op` box exercise the worst-case path fine. If
> you want it under the full 10k, run the op-mode harness against the cluster's
> operator-enabled nodes; but the HTTP round-trip is the worst case regardless of fleet
> size.

### Operator-book reconciliation (after an operator-mode soak)
For an operator-mode **soak** (with failure injection), reconcile the operator's book:
```bash
# BEFORE restarting the stub (its book is in-memory):
DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
  STUB_URL=http://localhost:4001 STUB_KEY=stub-key OPERATOR_CODE=load-stub \
  bun scripts/operator-recon-check.ts
# PASS: "OPERATOR BOOK RECONCILED — 0 discrepancies" (O1–O5).
```
To force `payout_pending` / exercise the operator-fault recovery path, run the stub
behind **toxiproxy** and inject latency/5xx on `/win` (point the operator row's
`walletApiUrl` at the toxiproxy listener). The seamless wallet surfaces
`payout_pending`; the reconciler drains it; `operator-recon-check.ts` O4 asserts the
backlog returned to 0. (Toxiproxy wiring is the one piece NOT yet scripted — see the
"gaps" note at the bottom.)

---

## 7. Teardown
```bash
# on each box:
docker compose --env-file load/.env.loadtest -f load/docker-compose.loadtest.yml down -v
# then DESTROY the Hetzner boxes (hourly billing — don't leave them running).
```

---

## 8. The risk-gate decision (what the numbers decide)
- **If 10k holds** (summed gauge ≥ 10k, settlement p99 < 200ms operator-mode, failover
  < 5s, 0 reconciliation discrepancies) via horizontal scaling (Redis adapter + N
  nodes) → **STAY on NestJS/Bun. No Go rewrite.** Record capacity/node + the cluster
  size that met 10k.
- **If settlement p99 can't be met** by scaling/tuning (e.g. it degrades with
  concurrency on a single node and adding nodes doesn't help because the per-event hot
  path is CPU-bound) → the documented risk-gate is to **rewrite ONLY the hot path
  (engine + gateway) in Go, contracts unchanged**. This is a big decision — **flag it
  for USER sign-off**; coordinate the money/fairness correctness of any rewrite with
  `money-path-auditor` / `fairness-verifier`.
- Either way: **the multi-node cutover** (managed Postgres [PgBouncer + replica +
  partitioning] + managed Redis + ≥2 WS nodes behind a LB) needs `deploy-verifier` +
  USER sign-off. Prod STAYS single-node (`6bfda18`) until then.

## 9. Capture template (paste numbers here per run)
```
DATE / commit:                __________ / 6bfda18
TARGET box:                   CCX33 (8 vCPU/32GB) | cluster: 2×CCX23 + LB + db
--- calibration ---
capacity/node (last-healthy ws_conn): ______   knee: server-side | gen-side
srvP99 at capacity:           ______ ms   peak api mem:       ______
--- 10k concurrency ---
summed ws_connections (peak): ______   per-node settlement p99: ______ ms
tick starvation?              none | ______   memory flat?       yes | creep
VERDICT 10k:                  MET | NOT MET @ ______ concurrent
--- settlement (operator mode) ---
server settlement p99:        ______ ms (buckets 100/200/...)  stub bet/win: ____/____
VERDICT settlement p99<200ms: MET | NOT MET
--- failover ---
gap (tick→tick):              ______ ms   resume: CONFIRMED | NOT   refunds: 0 | ____
VERDICT failover<5s:          MET | NOT MET
--- reconciliation ---
rounds soaked / kills:        ______ / ______   reconcile-check: RECONCILED | ____
operator-recon (if op soak):  RECONCILED | ____
VERDICT 0 discrepancies:      MET | NOT MET
--- risk gate ---
STAY NestJS  |  Go hot-path rewrite (flag for sign-off)
```
