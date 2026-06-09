# CHAOS-FAILOVER — reproducing the "failover < 5 s + 0-discrepancy" result

This is the canonical, reproducible record for the leader-failover chaos claim:

> When the engine **leader is hard-killed (SIGKILL) mid-round**, a survivor re-acquires
> leadership and **resumes the in-flight round within the < 5 s SLA**, with **zero money
> discrepancy** — the same round settles (`cashed_out`/`busted`) and the ride-through bets
> are **not** closed-and-refunded.

The proof is a **committed, self-contained harness** — not a one-off script:

| Artifact | What it is | Committed at |
|---|---|---|
| **`load/failover-drill.ts`** | The chaos harness. Spawns 2 election-eligible `bun run src/main.ts` nodes against one pg + redis, attaches split WS clients (some placing ride-through bets), **SIGKILLs the leader** mid-`running`, measures the tick-gap across the failover, and asserts the round resumed with **0 `restart_refund` rows**. | in-repo |
| `load/recon-soak.ts` | The repeated-failover money-conservation soak (SIGKILL+respawn on a cadence; asserts 0 new reconciliation discrepancies). The "0-discrepancy under chaos" half at volume. | in-repo |
| `load/cluster-harness.ts` | Shared boot + leader-mapping (`engine_leadership.node_id` ↔ child pid) used by both. | in-repo |

> **Not a CI gate (by design).** CI (`.github/workflows/ci.yml`) runs against a **single**
> postgres+redis with one app process — it typechecks (`tsconfig.json` + `tsconfig.scripts.json`,
> the latter now also typechecks this harness under `load/**`), runs `bun test`, and the
> single-node `scripts/reconcile-check.ts` money gate. A **true failover** needs **two live
> nodes racing for the pg advisory lock**, which a single-node CI runner can't provide. So this
> drill is a **manual multi-process / multi-node run**, executed before a multi-node cutover —
> see `../docs/DEPLOY.md` §16 and the roadmap (Phase 4.5c.3). It is exit-code clean
> (`process.exit(0)` only when timing AND resume both pass), so it *can* be wired into a
> multi-node pipeline later; it is intentionally **out of the single-node CI**.

---

## 1. Local reproduction (2 processes, dockerized pg + redis)

Two `bun` processes on one machine share the dockerized store. This measures **failover
timing + resume correctness**, not throughput.

```bash
# Prereqs: docker compose up -d postgres redis  (and migrations applied once)
# Stop any container fighting :3021/:3022 and the dev server first.
DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
  REDIS_URL="redis://localhost:6379" JWT_SECRET=x GAME_CURRENCY=DEMO \
  CLIENTS=16 bun load/failover-drill.ts
```

**PASS output** (the two lines that define the result):

```
>> FAILOVER GAP (tick→tick): 1635ms  ✅ < SLA
restart_refund ledger rows: 0  ✅ none (not close+refunded)
VERDICT: failover timing MET (gap <5000ms SLA)
         seamless resume CONFIRMED (round resumed + bets settled, no refund)
```

The script **exits 0** iff `timingOk && resumeOk` (gap ≥ 0 and < `FAILOVER_SLA_MS`, AND the
same round resumed with **0** `bet:{id}:restart_refund` rows). Any other outcome exits non-zero.

**Knobs (env):** `PORT_A`/`PORT_B` (3021/3022), `CLIENTS` (20), `BET_RATE` (0.6),
`KILL_AT_MULT` (1.15 — SIGKILL once the running multiplier crosses this), `FAILOVER_SLA_MS`
(5000), `MAX_WAIT_MS` (45000).

> ⚠️ **Both nodes must stay election-eligible** — do **not** set `GAME_AUTOSTART=false`. A node
> with autostart off is a permanent follower and can never take over, so there would be no
> survivor. The leader is identified from the authoritative `engine_leadership.node_id`
> (`${HOSTNAME}-${pid}`), mapped to its child by pid.

---

## 2. At-scale reproduction (2 node boxes + the shared store)

Run the **same** harness on a node box pointed at the shared store, optionally under
background load from a generator box. Full box plan: `load/RUN-10K.md` §5a.

```bash
DATABASE_URL="postgresql://vault:vault@<DB_PRIVATE_IP>:5432/vaultrun?schema=public" \
  REDIS_URL="redis://<REDIS_PRIVATE_IP>:6379" JWT_SECRET=loadtest-jwt-secret GAME_CURRENCY=DEMO \
  CLIENTS=40 KILL_AT_MULT=1.2 FAILOVER_SLA_MS=5000 \
  bun load/failover-drill.ts
# PASS: ">> FAILOVER GAP (tick→tick): <5000ms ✅ < SLA" AND "seamless resume CONFIRMED"
#       (0 restart_refund rows; ride-through bets settled cashed_out|busted).
```

To measure the gap **under load** (not idle), point `ws-load.ts` at the two nodes during the
drill. To prove **0-discrepancy under repeated** failover (not just one kill), run the
companion soak and then the canonical money gate:

```bash
DATABASE_URL=… REDIS_URL=… JWT_SECRET=loadtest-jwt-secret GAME_CURRENCY=DEMO \
  ROUNDS=100000 CLIENTS=60 BET_RATE=0.7 CASHOUT_AT=0 KILL_EVERY_MS=15000 \
  bun load/recon-soak.ts
DATABASE_URL=… bun scripts/reconcile-check.ts   # PASS: "RECONCILED — 0 money discrepancies"
```

---

## 3. Result on record (do not re-fabricate — re-measure)

Already proven on **staging** (multi-node, shared store):

- **Failover gaps 486–1550 ms over 31 rounds / 38 SIGKILLs** — every gap inside the 5 s SLA.
- **Reconciliation: RECONCILED / 0 discrepancies** across the repeated-failover soak.
- Locally (2 processes): gap ≈ **1.6 s** over 3 runs, 0 `restart_refund`.

These are the numbers `load/README.md` (§"4.5c.3 drill harness") and `load/RUN-10K.md` (§5)
also cite. They are a **record of past runs**, not a live guarantee — re-run the harness above
to regenerate them for a given build/cluster. The result has **not** been re-run end-to-end on a
production multi-node cluster (production is single-node today; multi-node is designed but not yet
load-run at scale — see the roadmap and `../docs/DEPLOY.md` §16).

## See also

- `load/README.md` — the SLA table + the full drill-harness section (failover + soak + operator).
- `load/RUN-10K.md` §5 — the at-scale failover + reconciliation box procedure.
- `../docs/DEPLOY.md` §16 — multi-node cutover gating (this drill is one of its pre-cutover gates).
