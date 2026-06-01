# Load & chaos testing (Phase 1)

k6 scenarios for the **HTTP/REST** surface of the Vault Run API, plus the
procedure for chaos testing. These are the Phase-1 "risk gate": run them against
**staging** (never the live demo DB — the guest-auth flow creates real rows) to
check the SLA before scaling decisions.

## What's covered

| Script | Shape | Gate |
|---|---|---|
| `k6-http.js` | ramp 0→VUS→0 | `http_req_failed`<1%, read `p95<200ms` / `p99<500ms` |
| `k6-spike.js` | sudden surge to PEAK, recover | `http_req_failed`<2%, `p95<500ms` |

Flow per virtual user: public reads (`/health`, `/api/fairness/current`,
`/api/round/current`, `/api/leaderboard`) + one guest auth (`POST
/api/auth/guest`, the DB write path) + an authed read (`/api/wallet/balance`).

## What's NOT covered — the WebSocket hot path

Bets and cash-outs run over **Socket.IO**, which k6 doesn't speak out of the box
(it's not raw WebSocket). Load-test that leg with the existing Socket.IO client:

```bash
bun scripts/load-test.ts        # see scripts/ for the WS bet/cash-out load
```

A future option is a k6 Socket.IO extension (xk6) if we want both legs in one tool.

## How to run

**Docker (no install):**
```bash
# macOS/Windows: reach the host API via host.docker.internal
docker run --rm -e BASE_URL=http://host.docker.internal:3001 \
  -v "$PWD/load:/load" grafana/k6 run /load/k6-http.js

# Linux: add --network host and use localhost
docker run --rm --network host -e BASE_URL=http://localhost:3001 \
  -v "$PWD/load:/load" grafana/k6 run /load/k6-http.js
```

**Local k6** (`brew install k6`):
```bash
BASE_URL=https://staging-api.vaultrun.app k6 run load/k6-http.js
```

**Tunables (env):** `BASE_URL`, `VUS` (peak users, default 50), `RAMP`, `HOLD`
for `k6-http.js`; `PEAK` (default 200) for `k6-spike.js`.

## Chaos testing (manual procedure)

k6 generates the load; you inject the failure and watch recovery via `/health`
(deep DB+Redis check) and `/metrics` (realized RTP, error counters).

1. Start a steady load: `... k6 run load/k6-http.js` (e.g. `VUS=50`).
2. Mid-run, kill a dependency and observe:
   - **Redis down:** `docker stop vaultrun-redis` → `/health` should flip to 503,
     errors rise; `docker start vaultrun-redis` → recovers.
   - **Postgres down:** `docker stop vaultrun-postgres` → 503; restart → recovers.
   - **API restart (engine recovery):** `docker restart vaultrun-api` → on boot,
     `recoverInterruptedRounds` refunds in-flight bets (Phase 1.4); no double-refund.
3. Record time-to-recover and whether any request returned a wrong (non-503)
   result. Target: failover <5s, no money discrepancy.
