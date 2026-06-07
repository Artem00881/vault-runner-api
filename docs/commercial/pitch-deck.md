# Vault Run — B2B Partner Pitch Deck

**Version:** 1.0  ·  **Date:** 2026-06-07  ·  **Audience:** operators & aggregators (commercial / BD)

> Slide-by-slide content for the Vault Run partner pitch. Each slide gives the
> on-slide bullets plus an italic _Speaker notes:_ line for the presenter. This is
> the substance; it may later be rendered to `.pptx`. All figures are kept
> consistent with `docs/game-math-spec.md`, `docs/simulation-report.md`,
> `docs/provably-fair-guide.md`, and `docs/api-integration-spec.md`. Commercial and
> compliance slides are deliberately **high-level** — detailed rev-share, SLA, and
> compliance-roadmap documents are produced separately.

---

## Slide 1 — Vault Run

- **A server-authoritative multiplayer crash game**, delivered as a Remote Game Server (RGS).
- Theme: a 3D **"vault heist."** Fast, social, instant-win.
- Integrates via a **seamless single-wallet** model — your wallet stays the source of truth.
- Live play-money demo: **vaultrun.app**

_Speaker notes: One line to remember us by — Vault Run is a crash game built RGS-first for clean seamless-wallet integration. The whole deck backs up two promises: it is provably fair, and it is operationally serious. Open the live demo at vaultrun.app while you talk._

---

## Slide 2 — The opportunity: crash is a category, not a fad

- Crash / instant-win is now a core casino vertical alongside slots and live — short rounds, high session frequency, strong on mobile and crypto.
- Players want **speed, a shared social round, and verifiable fairness** — crash delivers all three.
- Major aggregators already carry crash as a first-class content type.
- Operators need **differentiated** crash titles, not another clone, plus a supplier that integrates cleanly and reconciles to the cent.

_Speaker notes: Keep this short and uncontroversial — the buyer already believes in crash. Position Vault Run as a quality, differentiated entrant with a real engineering spine, not a reskin. Avoid quoting market-size numbers we cannot source._

---

## Slide 3 — What Vault Run is

- **Crash / instant-win**, one shared round on a single server clock — every player sees the same rising multiplier and the same crash point.
- **Server-authoritative**: the crash point is fixed before betting closes; the client multiplier is never trusted for money.
- **3D vault-heist presentation** layered on a deterministic, auditable engine.
- **Multi-currency from day one** — fiat and crypto, on one currency-agnostic math model.

_Speaker notes: The headline distinction is server-authoritative + provably fair. The 3D theme is the wrapper; the engine underneath is the product. "One math model, many currencies" is a recurring theme — say it here and on the math slide._

---

## Slide 4 — Signature mechanic: the dual-bet

- **Two independent panels — Quick Grab and Big Heist — sharing ONE crash point per round.**
- Each panel has its own stake and its own optional auto-cash-out target.
- Play one panel or both: e.g. bank a small safe early (Quick Grab) while letting a bigger position ride (Big Heist).
- More decisions per round → higher engagement, without changing the underlying fair curve.

_Speaker notes: This is our differentiator versus single-bet crash clones. Stress "one crash point, two positions" — they are not two separate games, so it is intuitive but adds real strategic depth. It maps directly to panel A / panel B in the integration spec._

---

## Slide 5 — The math, in one slide

- **RTP 97%** — house edge **3%**.
- Crash distribution: **P(crash ≥ x) = 0.97 / x**.
- **Instant-bust ≈ 3.96%** (the 1.00x clamp; this is distinct from the 3% house edge).
- **Max multiplier 10,000x** (real-money config; the public demo runs a 1,000,000x ceiling).
- **Currency-agnostic** integer minor-unit math — same model for EUR, USDT, BTC, everything.

_Speaker notes: Be precise: 3% is the house edge; 3.96% is the instant-bust rate — these are different quantities, and a savvy buyer or lab will check. RTP is constant across cash-out strategies, which is the hallmark of an honest crash curve. Full derivation lives in the game-math spec._

---

## Slide 6 — We don't claim the math — we prove it

- The crash curve is validated by a **1,000,000,000-round (1e9) Monte-Carlo simulation**.
- Run through the **exact production crash function** — not a re-implementation.
- **Measured RTP: 96.998%** (target 97%); instant-bust **3.96%**; `P(crash ≥ x)` matches `0.97/x` to 4–5 significant figures across six orders of magnitude.
- Reproducible: `bun scripts/simulate-rtp.ts 1000000000`. Raw output ships with the certification pack.

_Speaker notes: This is a trust slide. The key point for labs and operators: we simulate the real code, so the report describes what actually runs. 96.998% measured against a 97% target is the number to land. Offer the raw simulator output on request._

---

## Slide 7 — Provably fair, and grind-proof

- **Commit-reveal SHA-256 seed chain** + **HMAC-SHA256** crash derivation — the crash is fixed by a public commitment before any round plays.
- Players verify any finished round **in-browser or via public API** — zero trust in our server.
- **Grind-proof Ethereum block-hash salt**: the salt is a future finalized block hash, so seeds can't be pre-searched for a favourable result.
- Block-salt is **implemented and validated on Ethereum mainnet**; the public demo runs the random-salt provider by default — block-salt is one config flip away.

_Speaker notes: Two layers of trust. (1) The seed chain proves no seed was swapped. (2) The block-hash salt proves the operator couldn't grind the seeds — because the salt didn't exist when the chain was committed. Be accurate: the demo defaults to the random-salt provider; block-salt is built and mainnet-validated, enabled by one env flip. Don't overstate it as "always on."_

---

## Slide 8 — Integration: seamless single-wallet

- **Your wallet is the source of truth — Vault Run never holds player funds.**
- You implement four endpoints: **POST `/bet` · `/win` · `/rollback` · `/balance`**.
- **Idempotent on `transactionId`**; ambiguous debit timeout → automatic **rollback**; a won payout is **never clawed back** (retry + reconcile).
- Signed **launch token** (HMAC-SHA256, 120 s TTL, one-time use) → **Socket.IO** realtime play.
- **Per-operator reporting API** + reconciliation invariants + round history.

_Speaker notes: This is the engineer-comfort slide. The money-safety story is the headline: idempotency keys, rollback-on-ambiguous-debit, never-claw-back-on-win plus a reconciler. Every shape is documented in the API Integration Spec, with a runnable reference wallet stub. No custody of player money on our side — ever._

---

## Slide 9 — Built for many currencies

- Math is **currency-agnostic** (integer minor units); only **limits** are per-currency.
- Seeded today: **EUR, USD, GBP, CHF, CAD, AUD, BRL, INR, JPY** + **USDT, USDC, BTC, ETH** (plus DEMO).
- Correct precision per currency out of the box (JPY 0 dp, BTC 8 dp, ETH 18 dp, …).
- Per-currency **bet limits** and **responsible-gambling caps** are operator-configured at onboarding.

_Speaker notes: One math model, many currencies — repeat the theme. Crypto support is genuine (USDT/USDC/BTC/ETH seeded), which matters for crypto-first operators. Limits are per-currency config, not hard-coded, so you tune to your FX and risk policy._

---

## Slide 10 — Reliability & scale

- **HA design**: leader election + seamless failover — **deployed single-node on production today; multi-node designed, not yet load-run end-to-end at scale**.
- Single-node load tests: **≈ 4,400 connections/node in internal (play-money) mode**, **≈ 3,800–4,000 connections/node in operator (seamless-wallet) mode**; **settlement p99 < 200 ms** up to that knee.
- Edge: **Cloudflare + Caddy mTLS**; data: **PostgreSQL + Redis**; **monitoring + Sentry**.
- **Internally audited money path** — security, money-path, and fairness review tooling on every relevant change; **no third-party pentest yet**.

_Speaker notes: Be precise about the HA claim: the design supports leader-election + seamless failover, deployed single-node on prod — multi-node is designed but not yet load-run end-to-end at scale, so don't imply a tested cluster. The numbers are from Vault Run internal load tests, 2026-06 (Hetzner, single-node): ≈4,400 conn/node internal mode, ≈3,800–4,000 conn/node operator mode (a conservative lower bound — the generator was saturated), p99<200ms held to that knee (box ~90% idle; the ceiling was an application-level lock, not CPU); methodology and raw results available on request under NDA. The "internally audited" line is our internal review discipline — present it as process rigor, not certification, and note there is no third-party pentest yet._

---

## Slide 11 — Responsible gambling, built in

- **Reality checks** (interval, with optional enforce-and-acknowledge).
- **Session limits**: max duration, max loss, max wager — per operator, optionally per currency.
- Limits ride the **signed session token** — they can't be stripped client-side.
- **Cash-out and cancel are never RG-blocked** — an at-risk player can always retrieve their money; RG gates only new bets.

_Speaker notes: RG is table stakes for regulated operators. The defensible detail: limits live on the signed token (server-enforced), and we never block a player from getting their money out. Per-operator and per-currency config means it fits each jurisdiction._

---

## Slide 12 — Technology

- **NestJS / Node.js** (Bun runtime), **PostgreSQL**, **Redis**, **Socket.IO** realtime.
- Server-authoritative engine; deterministic, append-only money moves; no negative balances.
- Documented, stable wire contract; **Postman collection** available; **hosted operator sandbox forthcoming**.
- Clean tenant model: each operator has its own secret, wallet endpoint, currency allow-list, limits, RG config, and reporting key.

_Speaker notes: Keep this credible and brief. The stack is mainstream and operations-friendly. The two practical takeaways for an integrating team: the wire contract is documented and stable, and a Postman collection exists now with a hosted sandbox coming. Multi-tenancy is real, not bolted on._

---

## Slide 13 — Commercial model

- **Revenue share ~10–15% of GGR** — a market-standard reference point; **negotiable by volume, tier, and exclusivity**.
- **No player-funds custody** — your wallet is authoritative, simplifying your risk and reconciliation.
- Distribution either **direct-to-operator** or **via an aggregator** (details in the rev-share document).
- Simple, transparent structure — a flat GGR royalty, not a maze of fees.

_Speaker notes: Frame the 10–15% as a reference range we offer, anchored to market comparables, NOT as "the industry rate." Everything is negotiable on volume/tier/exclusivity. The detailed rev-share doc carries the breakdown and the direct-vs-aggregator options. Emphasize we hold no player money — that's a real risk reducer for them._

---

## Slide 14 — Service & support (SLA, draft)

- Target **99.9% uptime** (≥ 99.95% money-path target on the multi-node topology; interim single-node target is 99.9%) — _draft, negotiable_.
- Tiered support: **P1 15–30 min · P2 1–2 h · P3 4–8 h · P4 1 business day**.
- Scheduled-maintenance windows with notice; **service credits** for breaches.
- A real-time settlement-latency commitment, derived from our own load-test data.

_Speaker notes: Label this clearly as a DRAFT SLA, negotiable per contract. The numbers match common cloud/SaaS expectations our buyers will recognize. The latency commitment is set from our metrics, not copied from a generic template. Full terms live in the SLA document._

---

## Slide 15 — Compliance posture (be precise)

- **Ready now:** game-math spec, 1e9 simulation report, provably-fair guide, API integration spec + Postman, seamless wallet + reconciliation, responsible gambling, security hardening, HA/scale validation.
- **Forthcoming:** hosted operator-mode sandbox.
- **Planned (status only, not started):** pre-certification readiness review; **GLI-19 / iTech Labs RNG certification**; **ISO 27001**.
- **Licensing:** options under evaluation — Curaçao (post-LOK B2B) / MGA B2B "Critical Gaming Supply" / entry via a licensed aggregator. **No path chosen yet; we do not hold a gambling license today.**

_Speaker notes: This is the most important slide to get exactly right — do not overstate. We are "cert-ready, not yet certified." Say plainly: no certificate obtained, no license held, no licensing path committed. The strength is the evidence package, which maps cleanly to what a lab asks for upfront. Detailed status table is in the compliance-roadmap document._

---

## Slide 16 — Why Vault Run

- **Differentiated** crash via the dual-bet mechanic, on a deterministic, auditable engine.
- **Provably fair + grind-proof** — verifiable by anyone, mainnet-validated block-salt.
- **Clean seamless integration** — money-safe, idempotent, fully documented, with a reference wallet.
- **Operationally serious** — HA design (single-node load-tested; multi-node designed), monitored, internally audited money path (no third-party pentest yet); no player-funds custody.

_Speaker notes: The closer. Four pillars: differentiated game, provable fairness, clean integration, operational seriousness. Tie back to the live demo and hand off to next steps._

---

## Slide 17 — Next steps & contact

- **Play it now:** vaultrun.app (live play-money demo).
- **Read the integration:** API Integration Spec + Postman collection (hosted sandbox forthcoming).
- **Talk commercials:** rev-share, SLA, and compliance-roadmap documents available on request.
- **Contact:** `partnerships@vaultrun.example` · `https://vaultrun.example`

_Speaker notes: Give them three concrete actions: try the demo, review the docs, book a commercial call. Leave the contact placeholders to be replaced with the real partnership email and site before sending. Offer to walk a technical team through the sandbox once it's live._
