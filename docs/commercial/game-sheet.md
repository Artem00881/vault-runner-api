# Vault Run — B2B Game Sheet

**Version:** 1.0  ·  **Date:** 2026-06-07  ·  **Audience:** operators, aggregators, catalog / onboarding

> One-page specification for catalog/onboarding use. Figures are consistent with
> `docs/game-math-spec.md`, `docs/simulation-report.md`, `docs/provably-fair-guide.md`,
> and `docs/api-integration-spec.md`.

---

| Field                          | Value                                                                                        |
|--------------------------------|----------------------------------------------------------------------------------------------|
| **Game name**                  | Vault Run                                                                                    |
| **Supplier**                   | Vault Run (RGS)                                                                              |
| **Game type**                  | Crash / instant-win — server-authoritative multiplayer                                       |
| **Theme**                      | 3D "vault heist"                                                                             |
| **Format**                     | Single shared round on one server clock; fast rounds; social/multiplayer                     |
| **RTP**                        | **97.00%** (house edge 3.00%) — validated by a 1e9-round simulation (measured **96.998%**)   |
| **Volatility**                 | High (long-tail crash distribution, `P(crash ≥ x) = 0.97 / x`)                               |
| **Max multiplier**             | **10,000x** (real-money config) · 1,000,000x (play-money demo)                               |
| **Max win**                    | **€10,000 per bet** (EUR reference); €20,000 per player per round; configurable per currency |
| **Instant-bust frequency**     | **≈ 3.96%** (rounds resolving at 1.00x)                                                      |
| **Bet range**                  | EUR reference: **min €0.10 · max €100** — configurable per currency at onboarding            |
| **Min/max — other currencies** | Per-currency limits set by the operator in minor units (FX/risk policy)                      |
| **Round pacing**               | Betting window 5.0 s; inter-round pause 3.0 s; running phase variable until the crash point  |

---

## Signature feature — dual-bet

- **Two independent panels — Quick Grab (A) and Big Heist (B) — sharing ONE crash point per round.**
- Each panel has its own stake and its own optional **auto-cash-out** target.
- Bet one panel or both; cash each out independently (manual or auto).

## Features

- Dual-bet (two positions, one crash point) with per-panel auto-cash-out.
- Server-authoritative crash point — fixed before betting closes; client multiplier never trusted for money.
- **Provably fair**: commit-reveal SHA-256 seed chain + HMAC-SHA256; player-verifiable in-browser or via public API.
- **Grind-proof Ethereum block-hash salt** — implemented and validated on mainnet (demo defaults to the random-salt provider; block-salt is one config flip away).
- **Responsible gambling** built in: reality checks; session time / loss / wager limits; per-operator (and per-currency) config; cash-out is never RG-blocked.
- Public round history + provably-fair verification endpoints.

## Integration summary

- **Model:** seamless single-wallet RGS — operator wallet is the source of truth; Vault Run holds no player funds.
- **Operator implements:** `POST /bet`, `/win`, `/rollback`, `/balance` — **idempotent on `transactionId`**; ambiguous debit timeout → automatic rollback; won payouts never clawed back (retry + reconcile).
- **Launch:** signed launch token (HMAC-SHA256, 120 s TTL, one-time use) → `POST /api/operator/launch`.
- **Realtime:** Socket.IO (`place_bet` / `cash_out`, live `multiplier_update`, settlement events).
- **Reporting & reconciliation:** per-operator reporting API (summary / daily / per-bet) + reconciliation invariants; book keyed by `betId`.
- **Tooling:** Postman collection available; **hosted operator-mode sandbox live (`https://sandbox.vaultrun.app`)** (integration testing only — not under the production SLA); runnable reference operator-wallet stub provided.
- **Stack:** NestJS / Node.js (Bun runtime), PostgreSQL, Redis, Socket.IO; Cloudflare + Caddy mTLS edge.

## Currencies

- **Fiat:** EUR, USD, GBP, CHF, CAD, AUD, BRL, INR, JPY.
- **Crypto:** USDT, USDC, BTC, ETH.
- Currency-agnostic integer minor-unit math; correct precision per currency (e.g. JPY 0 dp, BTC 8 dp, ETH 18 dp). Operator enables whichever currencies it offers.

## Reliability & scale

- HA design (leader election + seamless failover), **deployed single-node on production; multi-node designed, not yet load-run end-to-end at scale**.
- Single-node load tests: **≈ 4,400 connections/node in internal (play-money) mode**, **≈ 3,800–4,000 connections/node in operator (seamless-wallet) mode** (conservative lower bound — generator saturated); **settlement p99 < 200 ms** up to that knee.
- Monitoring + Sentry; internal audits (security / money-path / fairness review tooling); **no third-party pentest yet**.

> Reliability figures: Vault Run internal load tests, 2026-06 (Hetzner, single-node); methodology and raw results available on request under NDA.

## Certification & compliance status

> Be precise — status only; nothing below is obtained.

- **Ready:** game-math spec · 1e9 simulation report · provably-fair guide · API integration spec + Postman · **hosted operator-mode sandbox (live, `https://sandbox.vaultrun.app`)** · seamless wallet + reconciliation · responsible gambling · security hardening · HA/scale (single-node validated; multi-node designed, not yet load-run).
- **Forthcoming:** — none currently.
- **Planned (not started):** pre-certification readiness review; **GLI-19 / iTech Labs RNG certification**; **ISO 27001**.
- **Licensing:** options under evaluation (Curaçao post-LOK B2B / MGA B2B "Critical Gaming Supply" / entry via a licensed aggregator). **No license held; no path committed.**

## Commercial

- Revenue share **~10–15% of GGR** (market-standard reference; negotiable by volume, tier, exclusivity).
- No player-funds custody (operator wallet is authoritative).
- SLA (draft, negotiable): target **99.9%** uptime (≥ 99.95% money paths); tiered support P1 15–30 min / P2 1–2 h / P3 4–8 h / P4 1 business day.

## Demo & contact

- **Live demo (play-money):** vaultrun.app
- **Documentation:** API Integration Spec · Game Math Spec · Simulation Report · Provably-Fair Guide (available on request)
- **Partnerships:** `partnerships@vaultrun.example`
- **Web:** `https://vaultrun.example`

---

_Display note: the game is responsive; mobile/PWA optimization is not independently verified and is not claimed here._
