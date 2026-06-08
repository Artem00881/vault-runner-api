# Vault Run — Aggregator Readiness Checklist

**Version:** 1.0  ·  **Date:** 2026-06-07  ·  **Audience:** operators, aggregators, partnerships / compliance

This checklist maps Vault Run against what every major casino-game **aggregator**
(e.g. SoftSwiss, Hub88, EveryMatrix / SlotMatrix, Relax "Silver Bullet", Stake
Engine) requires of a new game supplier, with Vault Run's **honest status** for
each item. It is intended for due diligence — what is **Ready** today, what is
**Forthcoming**, and what is **Planned** (a forward decision, not started).

> **Honesty statement.** We do **not** overstate readiness. **Lab certification and
> a B2B/operator license are PLANNED / options — they are not done.** Where an item
> is a business or jurisdictional decision (license route, certification timing) we
> say so. Status definitions:
>
> - **Ready** — built, tested, and in the current codebase (cited to the spec/code).
> - **Forthcoming** — committed and in progress (a known next deliverable).
> - **Planned** — a recognized requirement we have **not started**; a forward
>   decision (cost/timeline indicative only).
> - **Options** — multiple viable paths; **no path chosen yet**.

---

## 1. The four onboarding gates every major aggregator requires

Across every major aggregator checked in our market research, a new game supplier
must clear four gates. This is the **common pattern** (stated explicitly by Hub88
and SoftSwiss; consistent across platforms).

| # | Gate | What it means | Vault Run status |
|---|---|---|---|
| **1** | **Lab certification** | The game/RNG is tested and certified by a recognized lab (GLI, iTech Labs, eCOGRA, or BMM). Aggregators state every game on-platform is lab-certified. | **Planned** — not certified. We have a strong **cert-readiness evidence package** (math spec, 1e9 simulation report run through the exact production function, provably-fair guide), but **no certificate is held**. See `compliance-roadmap.md`. |
| **2** | **Seamless single-wallet API** | A single seamless-wallet integration (operator wallet stays authoritative; the RGS never holds funds) plus full API/technical docs. | **Ready** — seamless wallet (`/bet` `/win` `/rollback` `/balance`, idempotent on `transactionId`, ambiguous-timeout → rollback), signed launch token, Socket.IO game protocol, reconciliation, reporting. Fully documented in `../api-integration-spec.md`; Postman collection shipped. **Hosted operator-mode sandbox live (`https://sandbox.vaultrun.app`)** — integration testing only, not under the production SLA. |
| **3** | **KYB / UBO due diligence** | Know-Your-Business onboarding: company registration/incorporation, ownership structure, **Ultimate Beneficial Owner(s)** identification + government ID, licensing status, and adverse-media screening. | **Forthcoming (process)** — this is a counterparty due-diligence step we complete at onboarding by providing a KYB pack (incorporation docs, UBO chart + IDs, license status, AML policy). The pack is prepared on engagement; nothing here is a product feature, and depth scales with the counterparty's risk assessment. |
| **4** | **Recognized / tier-one B2B license** | Major aggregators require partners to hold a license from a reputable jurisdiction (e.g. MGA, UKGC, Curaçao) — explicitly stated by Hub88, and consistent across the platforms we checked. This is coupled to gate 1 and to the markets targeted. | **Planned / Options** — **we do not hold a B2B supplier license.** Candidate routes are Curaçao (post-LOK), MGA B2B "Critical Gaming Supply", or distributing **via a licensed aggregator** under its umbrella. **No path chosen.** See `compliance-roadmap.md`. |

> **Two of the four gates (cert + license) are not done.** A pragmatic route that
> some platforms support is distributing **via an aggregator** that provides
> certification/compliance cover under its umbrella (e.g. several platforms position
> this for vetted independent studios), lowering the immediate cert/license barrier
> in exchange for the aggregator's rev-share layer (`revenue-share-model.md` §4).
> Confirm the exact scope of any "we cover your certification" arrangement directly
> with the platform — that claim is secondary in our research.

---

## 2. Technical-readiness checklist

These are the technical capabilities aggregators and operators evaluate during
integration and due diligence. Each is cited to the implementation/spec.

| Capability | Status | Evidence / notes |
|---|---|---|
| **Idempotency** | **Ready** | Every money move (`/bet` `/win` `/rollback`) carries a unique `transactionId`; the operator must dedup on it. Stable keys: `bet:{roundId}:{userId}:{panel}:debit`, `bet:{betId}:payout`, `bet:{betId}:refund`. `../api-integration-spec.md` §9. |
| **Ambiguous-timeout safety** | **Ready** | On a timed-out **debit**, the RGS issues an idempotent `/rollback` and rejects the bet (never blind-retries → no double-charge). A won payout is **never** clawed back; on an unconfirmed `/win` the RGS retries idempotently and reconciles via `payout_pending`. `../api-integration-spec.md` §9. |
| **Reconciliation** | **Ready** | Documented reconciliation invariants (win linkage, busted purity, stake linkage, backlog drained, conservation) plus an automated money-conservation check (`scripts/operator-recon-check.ts`, O1–O5) run as a gate after load soaks. `../api-integration-spec.md` §10. |
| **Reporting API** | **Ready** | Per-operator reporting (`summary` / `daily` / per-bet `bets`), hard-scoped to the operator's `operatorId` (taken from the key, never the query), money in minor units as decimal strings, demo excluded by default. Plus public round history. `../api-integration-spec.md` §13. |
| **Responsible gambling** | **Ready** | Built-in reality checks and session **time / loss / wager** limits, configured per operator and carried on the signed session token (cannot be stripped client-side). Cash-out/cancel are never RG-blocked. `../api-integration-spec.md` §11. |
| **Multi-currency** | **Ready** | Currency-agnostic integer-minor-unit math from day one; per-currency limits only. Fiat + crypto (USDT/USDC/BTC/ETH) supported; canonical precision table at `GET /api/currencies`. `../game-math-spec.md` §8/§12; `../api-integration-spec.md` §8. |
| **Provably-fair** | **Ready** | SHA-256 seed chain + HMAC crash derivation; **Ethereum block-hash salt implemented and mainnet-validated** (grind-proof; demo defaults to random salt, block-salt one env flip away); player-verifiable in-browser, via API, or offline. `../provably-fair-guide.md`. |
| **HA / scale** | **Ready (single-node validated; multi-node designed, not yet load-run)** | Leader election + seamless failover, **deployed single-node on production**. Single-node load tests: **≈ 4,400 connections/node in internal (play-money) mode**, **≈ 3,800–4,000 connections/node in operator (seamless-wallet) mode** (a conservative lower bound — the load generator was saturated), settlement **p99 < 200 ms** up to that knee (the box stayed ~90% idle; the ceiling was an application-level lock, not CPU). **Multi-node has not yet been load-run end-to-end at scale.** Source: Vault Run internal load tests, 2026-06 (Hetzner, single-node); methodology and raw results available on request under NDA. |
| **Security hardening** | **Ready** | Cloudflare + Caddy mTLS edge; bearer-locked metrics; per-socket (15 msg/s) and per-operator rate limits; signed, short-lived launch tokens (120 s TTL, single-use `jti`) and session tokens (revocable). **Internal adversarial security audit + remediation on record; money path reviewed by automated audit tooling. No third-party penetration test has been commissioned yet** (pairs with ISO/IEC 27001 = Planned). `../api-integration-spec.md` §4/§6/§9. |
| **Game math + RTP evidence** | **Ready** | RTP **97%**, house edge 3%, max **10,000x** (real-money), instant-bust **3.96%**; validated by a **1e9-round** simulation through the exact production crash function (measured RTP **96.998%**). `../game-math-spec.md`; `../simulation-report.md`. |
| **API documentation + Postman** | **Ready** | Full integration spec (`../api-integration-spec.md`) plus a Postman collection and environment file (variables) (`../postman-collection-guide.md`, `../vaultrun-api.postman_collection.json`). |
| **Hosted operator-mode sandbox** | **Ready** | **Live at `https://sandbox.vaultrun.app`** — a hosted environment exercising the real operator-wallet contract end-to-end (against an operator-wallet stub). Wire shapes are stable. Production today runs operator-mode **OFF** (internal play-money demo). Integration testing only — **not** under the production SLA (`sla.md` §9). `../api-integration-spec.md` §14. |
| **Lab certification (GLI-19 / iTech RNG)** | **Planned** | Not certified. Evidence package is cert-ready; formal submission, jurisdiction selection, and a near-production RNG output-collection tool in the lab's format are not done. Cost/timeline indicative only. `compliance-roadmap.md`. |
| **ISO/IEC 27001** | **Planned** | Not held. Recognized as a high-leverage credibility/security item that speeds operator due diligence and lab testing; not started. `compliance-roadmap.md`. |
| **B2B supplier license** | **Planned / Options** | Not held. Curaçao (post-LOK) / MGA B2B / via-aggregator umbrella; **no route chosen.** `compliance-roadmap.md`. |

---

## 3. Quick status summary

| Status | Items |
|---|---|
| **Ready** | Seamless single-wallet API, idempotency, ambiguous-timeout safety, reconciliation, reporting API, responsible gambling, multi-currency, provably-fair (incl. block-salt), HA/scale (single-node validated; multi-node designed, not yet load-run), security hardening, game-math + 1e9 RTP evidence, API docs + Postman, **hosted operator-mode sandbox (live, `https://sandbox.vaultrun.app`)**. |
| **Forthcoming** | KYB/UBO pack (prepared at onboarding). |
| **Planned (not started)** | Lab certification (GLI-19 / iTech RNG), ISO/IEC 27001. |
| **Options (no path chosen)** | B2B supplier license — Curaçao (post-LOK) / MGA B2B / via licensed aggregator. |

---

## 4. Honest gap statement

Of the four onboarding gates, **two are met today** (seamless single-wallet API +
the technical-readiness stack; the KYB pack is a standard onboarding step) and
**two are not** — **lab certification** and a **recognized B2B license**. Both are
**deliberately Planned/Options**, not in progress, and represent a forward business
and jurisdictional decision (including the lower-friction route of launching via an
aggregator that provides certification/compliance cover). We can credibly present
the **standard, the evidence package, and indicative cost/time** without claiming a
certificate or license we do not hold. Indicative cert/license figures are
**secondary/vendor-quoted-privately** — see `compliance-roadmap.md` for the
caveated detail.

Companion documents: `compliance-roadmap.md` (capability status table),
`revenue-share-model.md` (commercial model), `sla.md` (service levels),
`../api-integration-spec.md` (technical integration), `../provably-fair-guide.md`,
`../game-math-spec.md`, `../simulation-report.md`.
