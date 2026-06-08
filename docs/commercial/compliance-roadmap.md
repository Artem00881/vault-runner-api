# Vault Run — Compliance & Certification Roadmap (Status)

**Version:** 1.0  ·  **Date:** 2026-06-07  ·  **Audience:** operators, aggregators, compliance / legal

This is a **status table**, not a work plan. It states, for each compliance- and
trust-relevant capability, where Vault Run stands today using four statuses:

- **Ready** — built, tested, and in the current codebase; usable now.
- **Forthcoming** — committed and in progress (a known next deliverable).
- **Planned** — a recognized requirement we have **not started**; a forward
  decision. Any cost/timeline shown is **indicative only**.
- **Options** — multiple viable paths exist; **no path has been chosen**.

> **Read this first.** **Certification and licensing are intentionally listed as
> status / options only** — they are a deliberate forward decision for the operator
> and for us, **not work in progress and not done**. We hold **no lab certificate
> and no gambling license**, and nothing in this document should be read to imply
> otherwise. Indicative cert/license figures below are **secondary or
> vendor-quoted-privately** (labs and regulators quote per project) — treat them as
> ranges, not quotes.

---

## 1. Status table

| # | Capability | Status | Evidence / notes |
|---|---|---|---|
| 1 | **Game-math specification** | **Ready** | RTP **97%**, house edge 3%, max **10,000x** (real-money), instant-bust **3.96%**, currency-agnostic integer-minor-unit math, dual-bet sharing one crash point. Documented in `../game-math-spec.md`; derived from the production crash function. |
| 2 | **1e9-round simulation report** | **Ready** | 1,000,000,000 rounds through the **exact production** crash function; measured RTP **96.998%**, instant-bust **3.96%**, `P(crash ≥ x) = 0.97/x` matched to 4–5 significant figures. `../simulation-report.md`. |
| 3 | **Provably-fair (incl. block-salt)** | **Ready** | SHA-256 seed chain + HMAC crash derivation; **Ethereum block-hash salt implemented and validated against mainnet** (grind-proof). Demo defaults to a random salt; block-salt is one env flip away. Player-verifiable in-browser, via API, or offline. `../provably-fair-guide.md`. |
| 4 | **API integration spec + Postman** | **Ready** | Full seamless-wallet / RGS integration spec (`../api-integration-spec.md`) plus a Postman collection and environment file (variables) (`../postman-collection-guide.md`, `../vaultrun-api.postman_collection.json`). |
| 5 | **Hosted operator-mode sandbox** | **Ready** | **Live at `https://sandbox.vaultrun.app`** — a hosted environment exercising the real operator-wallet contract end-to-end (against an operator-wallet stub). Wire shapes are stable; production currently runs operator-mode **OFF** (internal play-money demo). The sandbox is for integration testing and is **not** under the production SLA (`sla.md` §9). `../api-integration-spec.md` §14. |
| 6 | **Seamless wallet + reconciliation** | **Ready** | `/bet` `/win` `/rollback` `/balance`, **idempotent on `transactionId`**, ambiguous-timeout → rollback, never-claw-back + reconcile on a win. Reconciliation invariants + automated money-conservation check. **No player-funds custody.** `../api-integration-spec.md` §7/§9/§10. |
| 7 | **Responsible gambling** | **Ready** | Built-in reality checks and session **time / loss / wager** limits, per-operator, carried on the signed session token (cannot be stripped client-side); cash-out/cancel never RG-blocked. `../api-integration-spec.md` §11. |
| 8 | **Security hardening** | **Ready** | Cloudflare + Caddy mTLS edge; bearer-locked metrics; per-socket (15 msg/s) + per-operator rate limits; signed short-lived launch tokens (120 s, single-use) and revocable session tokens. **Internal adversarial security audit + remediation on record; money path reviewed by automated audit tooling. No third-party penetration test has been commissioned yet** (pairs with ISO/IEC 27001 = Planned, row 12). `../api-integration-spec.md`. |
| 9 | **HA / scale validation** | **Ready (single-node validated; multi-node designed, not yet load-run)** | Leader election + seamless failover, **deployed single-node on production**. Single-node load tests: **≈ 4,400 connections/node in internal (play-money) mode**, **≈ 3,800–4,000 connections/node in operator (seamless-wallet) mode** (a conservative lower bound — the load generator was saturated), settlement **p99 < 200 ms** up to that knee (the box stayed ~90% idle; the ceiling was an application-level lock, not CPU). **Multi-node has not yet been load-run end-to-end at scale.** Source: Vault Run internal load tests, 2026-06 (Hetzner, single-node); methodology and raw results available on request under NDA. `sla.md` §3. |
| 10 | **Pre-certification readiness review** | **Planned** | A paid pre-engagement where a lab/consultant reviews our math spec, RNG implementation/source, simulation evidence, and docs against the target standard **before** formal submission, to surface defects early. **Not started.** No fixed public price (quoted privately). |
| 11 | **GLI-19 / iTech RNG certification** | **Planned (status only)** | Not certified. **GLI-19** (Interactive Gaming Systems, incl. an RNG chapter) is the primary target standard for an online RGS; **iTech Labs** RNG testing is a strong, often lower-friction alternative; **BMM** is a third option. Indicative single-game band: **~€25k–€40k initial, ~4–12 weeks** (secondary / vendor-quoted privately — **not** a quote; the larger ~$75k–$150k / 4–6-month figures are for a **full multi-game platform** and do not apply to our single crash game). |
| 12 | **ISO/IEC 27001** | **Planned** | Not held. Information-security standard increasingly expected of B2B suppliers; some jurisdictions require it of licensees/service providers, others waive parts of their security audit if you hold it, and it speeds lab testing and operator due diligence. Pursuable independently of any gambling regulator. **Not started.** |
| 13 | **B2B supplier license** | **Options (no path chosen)** | **We do not hold a license.** Routes: **Curaçao (post-LOK)** — the typical lower-barrier entry (indicative ~€4,592 application + ~€24,490/yr supervisory; B2B supplier licensing phasing in around **Dec 2026**, with new substance requirements); **MGA B2B "Critical Gaming Supply"** — the credibility/market-access upgrade (indicative €5,000 application + €25k–€35k/yr annual, ~4–6 months, ~€40k share capital); or **via a licensed aggregator** under its umbrella. **No route selected** — it depends on which markets/operators we target first and is a business/legal decision for counsel. |

---

## 2. Status roll-up

| Status | Capabilities |
|---|---|
| **Ready** | Game-math spec · 1e9 simulation report · provably-fair (incl. block-salt) · API spec + Postman · **hosted operator-mode sandbox (live, `https://sandbox.vaultrun.app`)** · seamless wallet + reconciliation · responsible gambling · security hardening · HA/scale validation. |
| **Forthcoming** | — none currently. |
| **Planned (not started)** | Pre-certification review · GLI-19 / iTech RNG certification (status only) · ISO/IEC 27001. |
| **Options (no path chosen)** | B2B supplier license — Curaçao (post-LOK) / MGA B2B / via licensed aggregator. |

---

## 3. Why certification & licensing are "status / options" only

Certification and licensing are listed deliberately as **status and options, not as
in-progress work**, because:

- They are a **forward business and jurisdictional decision** that depends on which
  markets and operators we target first and on our distribution posture (direct vs.
  via a licensed aggregator — `revenue-share-model.md` §3). Several aggregators
  provide certification/compliance cover under their umbrella, which can change
  whether we pursue our own certificate/license at all.
- The lab and license **cost/timeline figures are indicative** — largely secondary
  sources or privately quoted (labs and regulators do not publish fixed prices;
  Curaçao's post-LOK B2B regime and its ~Dec 2026 phase-in are still bedding in).
  Presenting them as committed work would overstate certainty.
- We can already stand behind a credible **cert-readiness evidence package** — the
  game-math spec, the 1e9 simulation report (run through the exact production
  function), the provably-fair guide, the API spec, the seamless-wallet +
  reconciliation design, RG, security hardening, and HA/scale validation — **without
  claiming a certificate or license we do not hold.** The honest line is
  **"cert-ready, not yet certified; no license held."**

This document is internally consistent with `aggregator-readiness-checklist.md`
(the four onboarding gates), `revenue-share-model.md` (commercial model), `sla.md`
(service levels), and the technical docs (`../api-integration-spec.md`,
`../game-math-spec.md`, `../simulation-report.md`, `../provably-fair-guide.md`).
