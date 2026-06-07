# Vault Run — Revenue-Share Model

**Version:** 1.0  ·  **Date:** 2026-06-07  ·  **Audience:** operators, aggregators, commercial / BD

Vault Run is a server-authoritative multiplayer **crash** Remote Game Server (RGS)
with a seamless single-wallet integration (see `../api-integration-spec.md`). This
document describes the commercial model we propose for distributing Vault Run to
operators — directly or through an aggregator.

> **This is a commercial reference, not a price quote.** The headline figure below
> is an indicative, market-anchored starting point. Actual terms are negotiated per
> deal and move with monthly volume, tier, currency mix, exclusivity, minimum
> guarantees, market (regulated vs. non-regulated), and whether the deal is direct
> or via an aggregator. Nothing here is a binding offer; the final number is a
> business decision made jointly with the counterparty.

---

## 1. Headline: ~10–15% of GGR

Our proposed revenue share is a royalty of **approximately 10–15% of Gross Gaming
Revenue (GGR)** on Vault Run, paid monthly, with **no player-funds custody** on our
side (the operator's wallet remains authoritative — see §6).

- **Anchor — directly comparable RGS benchmark:** Stake Engine, an RGS for
  independent developers, publishes an explicit **10% GGR royalty** (the developer
  keeps ~90% of GGR). This is the closest public, comparable model to ours — a flat
  GGR royalty for an independent RGS layer — and it anchors the low end of our band.
- **Anchor — premium RNG-content supplier bands:** specialist B2B sources place
  direct supplier→operator RNG content at roughly **11–26% of GGR** for premium
  brands (lesser-known providers lower), and a broader industry overview cites a
  **7–20% of GGR** band. Our **~10–15%** sits at the lower-to-mid of these ranges —
  positioned as an independent crash RGS, not a legacy top-tier brand.

> **Sourcing note (for transparency).** These benchmarks are **market context, not
> contracts.** The clearest supplier ranges come from a single specialist source
> (an aggregator with a selling incentive); the studio/aggregator/operator splits
> are secondary synthesis (industry glossaries/blogs). The **Stake Engine 10%** is
> the best-sourced, most directly comparable figure (Stake's own published model,
> corroborated by multiple outlets). **No crash-specific public rev-share % exists**
> — the slots/RNG bands are used as the closest proxy. Treat every percentage in
> this document as **indicative and negotiable**, never as an industry "rate."

### What moves the number

| Lever | Effect on our share |
|---|---|
| Monthly GGR volume | Higher committed/observed volume → lower % (volume tiers, §3). |
| Minimum guarantee (MG) | A committed monthly minimum can buy a lower % or better terms. |
| Exclusivity | Market/brand exclusivity is a premium → typically a higher %. |
| Direct vs. via aggregator | Direct keeps the full supplier share with us; via an aggregator, the aggregator's layer is added **on top** (§4). |
| Market & currency mix | Regulated markets, fiat vs. crypto, and FX/settlement handling can shift terms. |
| Term length & ramp | Longer terms / launch ramps can be reflected in tiering. |

---

## 2. What the revenue share includes

The royalty is **all-in for the running game** — there is no separate per-seat,
per-API-call, or per-round fee in the base model. For the share, the operator
receives:

| Included | Detail |
|---|---|
| **Hosting & operation** | We run the RGS (game engine, RNG, WebSocket game server, settlement). Stack: NestJS/Node.js on the Bun runtime, PostgreSQL, Redis, Socket.IO, behind Cloudflare + Caddy mTLS. |
| **Game updates & maintenance** | Engine fixes, math-config maintenance, security patches, and feature updates to the game, delivered without a separate charge. |
| **Seamless wallet integration support** | Integration assistance for `/bet` `/win` `/rollback` `/balance` (idempotent on `transactionId`, ambiguous-timeout → rollback), the signed launch-token flow, and the Socket.IO game protocol (`../api-integration-spec.md`). |
| **Reporting** | Per-operator reporting API (summary / daily / per-bet), hard-scoped to the operator's `operatorId`, plus public round history (`../api-integration-spec.md` §13). |
| **Reconciliation** | Reconciliation invariants and a money-conservation check (`../api-integration-spec.md` §10), so the operator can reconcile their authoritative ledger against our journal. |
| **Provably-fair** | SHA-256 seed-chain + HMAC crash derivation with an Ethereum block-hash salt option (implemented, mainnet-validated; demo defaults to random salt), player-verifiable (`../provably-fair-guide.md`). |
| **Responsible gambling** | Built-in reality checks and session time / loss / wager limits, configured per operator (`../api-integration-spec.md` §11). |
| **Reliability** | High-availability design (leader election + seamless failover) **deployed single-node on production; multi-node designed, not yet load-run end-to-end at scale**. Single-node load tests held **≈ 4,400 concurrent connections/node in internal (play-money) mode** and **≈ 3,800–4,000 connections/node in operator (seamless-wallet) mode** with settlement **p99 < 200 ms** up to that knee — the operator figure is a conservative **lower bound** (the load generator was saturated during that run). Plus monitoring + Sentry. Money path covered by an **internal adversarial security audit + remediation on record and reviewed by automated audit tooling; no third-party penetration test has been commissioned yet.** Source: Vault Run internal load tests, 2026-06 (Hetzner, single-node); methodology and raw results available on request under NDA. |

Items **not** included in the base royalty and quoted separately if applicable:
one-off integration/onboarding fees (if any), lab certification fees (operator's or
shared decision — see `compliance-roadmap.md`), and any operator-requested custom
development. The SLA (`sla.md`) is a separate negotiable schedule.

---

## 3. Distribution posture: direct vs. via aggregator

We can distribute Vault Run two ways. The rev-share structure differs because of
**who books the GGR** and **how many layers sit between the game and the operator**.

### 3.1 Direct (operator integrates Vault Run directly)

```
   Player stakes ──▶ Operator (books GGR) ──▶ Vault Run royalty (~10–15% of GGR)
```

- We capture the full supplier share; the operator integrates our seamless wallet
  and reporting directly.
- We carry the integration and KYB/onboarding load with the operator.
- Simplest layering: one royalty on the operator's GGR for the game.

### 3.2 Via an aggregator (operator reaches Vault Run through a platform)

```
   Player stakes ──▶ Operator ──▶ Aggregator layer ──▶ Vault Run royalty
                                   (adds its own cut on top of our share)
```

- An aggregator gives faster multi-operator reach and a single integration for the
  operator, but **adds its own cut on top** of our share (§4).
- Some aggregators provide certification/compliance cover under their umbrella,
  which can lower our certification barrier — at the cost of the aggregator layer.
- Trade-off: reach and reduced compliance friction vs. a thinner net share to us
  and a higher total content cost to the operator.

### Indicative volume tiering (illustrative, not a quote)

A simple monthly-GGR tier ladder we can apply on the direct model (numbers are
illustrative anchors within the **~10–15%** band, to be set per deal):

| Monthly GGR on Vault Run (per currency or reference) | Indicative royalty |
|---|---|
| Launch / lower volume | ~15% of GGR |
| Mid volume | ~12.5% of GGR |
| High volume / with minimum guarantee | ~10% of GGR |

> These tier breakpoints are **placeholders for negotiation**, anchored to the
> market band in §1. We do not publish fixed breakpoints; they are set with the
> counterparty against committed/observed volume.

---

## 4. How an aggregator's cut layers on top

When Vault Run is distributed **through** an aggregator, the aggregator's fee is
**additive on top of our share** — it is not carved out of our royalty. Market
context (secondary synthesis, indicative):

- An aggregator's markup over direct-studio terms is commonly **~5–15% of game
  GGR**.
- One published breakdown frames the split as studio **~15–25%**, aggregator
  **~5–10%**, operator keeps the rest.
- The operator's **total content cost** via an aggregator is often cited at
  **~15–35% of GGR/NGR**, depending on the aggregator, volume, and negotiation
  leverage.
- Aggregators also frequently charge a **setup fee** and sometimes additional
  content/integration fees on top of the ongoing rev-share.

> **Important layering caveat (from the research).** "Supplier % of GGR" and
> "aggregator/platform % of GGR" are **two different layers and are not directly
> additive** without knowing **who books the GGR** at each step. The diagram below
> is a simplified illustration; the exact arithmetic depends on the specific
> aggregator contract and where GGR is measured. Treat the combined figure as an
> **indicative envelope**, not a formula.

```
                       Player net loss on Vault Run = GGR (€X)
                                     │
        ┌────────────────────────────┼──────────────────────────────┐
        ▼                            ▼                              ▼
  Operator keeps            Aggregator cut                  Vault Run royalty
  the remainder            (~5–15% of GGR, on top)         (~10–15% of GGR)
   (the rest)               [via-aggregator only]           [our share]
```

So, **direct**: operator pays ~10–15% of GGR (our share) and keeps the rest.
**Via aggregator**: operator's total content cost is higher (often ~15–35% of GGR
in market terms), of which the aggregator takes its layer and we take ours.

---

## 5. Worked numeric example

The example is illustrative; substitute real GGR. We use **EUR** for clarity (the
math is currency-agnostic — see `../game-math-spec.md` §8).

**Setup.** Over one month on Vault Run, an operator records, in EUR:

- Total wagered (turnover): **€1,000,000**
- Total paid out (wins): **€970,000**
- **GGR = wagered − won = €1,000,000 − €970,000 = €30,000**

This matches Vault Run's 97% RTP / 3% house edge over enough volume: GGR ≈ 3% of
turnover (`../game-math-spec.md` §5; `../simulation-report.md` measured
**96.998%** RTP over 1e9 rounds). Short-run GGR varies around this with player
behaviour; over a month at meaningful volume it converges toward ~3% of turnover.
Crash is higher-variance than slots (a heavy upper tail), so a single month's
realized GGR can swing further from 3% than the long-run average; the ~3% holds in
expectation and over sustained volume.

### 5.1 Direct deal

| Royalty rate | Vault Run share (of €30,000 GGR) | Operator keeps |
|---|---|---|
| 10% | **€3,000** | €27,000 |
| 12.5% | **€3,750** | €26,250 |
| 15% | **€4,500** | €25,500 |

### 5.2 Via an aggregator (illustrative)

Add an aggregator layer of, say, **10% of GGR** on top of a **12.5%** Vault Run
royalty:

| Party | Cut (of €30,000 GGR) | Amount |
|---|---|---|
| Vault Run royalty | 12.5% | **€3,750** |
| Aggregator layer | 10% | **€3,000** |
| Operator keeps | remainder | **€23,250** |

> The aggregator figure here is **illustrative** and depends on the actual
> aggregator contract and where GGR is booked (§4 caveat). It is shown only to make
> the layering concrete.

### 5.3 Scaling note

Because the royalty is a percentage of GGR (which tracks turnover at ~3%), our
share scales linearly with volume: at **€10,000,000** monthly turnover (≈
**€300,000** GGR), a 12.5% royalty is **≈ €37,500/month**; a volume tier might move
that rate toward 10% (≈ €30,000) under a minimum guarantee. Exact tiering is per
deal (§3.3).

---

## 6. GGR vs. NGR — definitions and which we use

We quote our share on **GGR** by default, because it is the cleaner, more
operator-neutral base for an RGS royalty. Both terms appear in operator contracts,
so we define them precisely:

| Term | Definition | Notes |
|---|---|---|
| **GGR** (Gross Gaming Revenue) | `total wagered − total paid out` (turnover minus wins). | The base we quote on. For Vault Run this is structurally ~3% of turnover over volume (97% RTP). Sometimes called "gross win." |
| **NGR** (Net Gaming Revenue) | GGR **minus** deductions: typically bonuses/free-bet costs, payment-processing fees, gaming taxes/levies, and sometimes affiliate/marketing costs. | Always **≤ GGR**. The exact deductions vary by operator and contract and must be defined explicitly if NGR is used. |

Implications for a deal:

- A given percentage **on NGR yields less** than the same percentage on GGR,
  because NGR nets off operator-side costs we do not control. If a counterparty
  prefers an NGR base, the rate is typically set **higher** to reach an equivalent
  economic outcome, and the **deduction list must be enumerated** in the contract
  (otherwise NGR is undefined).
- **Bonus/free-bet handling** is the most material NGR deduction to pin down: who
  bears the cost of bonused stakes, and whether bonused turnover counts toward GGR.
- Our reporting computes **GGR** per currency directly (`wagered − won`; see
  `../api-integration-spec.md` §13.1, `ggr` field), so a GGR-based deal reconciles
  one-to-one against our reports. An NGR-based deal requires the operator's
  deduction data, which lives on the operator side.

**Default position:** Vault Run royalty is **% of GGR**, reconciled against our
per-operator GGR reporting. We can negotiate an NGR base, but only with an explicit
deduction schedule.

---

## 7. Summary

- **Headline:** **~10–15% of GGR**, monthly, all-in for the running game — an
  indicative, market-anchored **reference, not a fixed quote** (negotiable by
  volume, tier, exclusivity, MG, market, and direct-vs-aggregator).
- **Anchors:** Stake Engine's published **10% GGR** RGS royalty (closest
  comparable) and premium RNG-supplier bands of **~11–26% of GGR** (we sit
  lower-to-mid as an independent crash RGS). All figures are **market context, not
  contracts**, and no crash-specific public rate exists — slots/RNG bands are the
  proxy.
- **Includes:** hosting & operation, game updates, integration support, reporting,
  reconciliation, provably-fair, responsible gambling, and HA/reliability.
- **Aggregator layer** is **additive on top** (~5–15% of GGR in market terms),
  raising the operator's total content cost (~15–35% of GGR), with the layering
  caveat that the layers are not naively additive.
- **Base is GGR** (reconciled against our GGR reporting); NGR is negotiable only
  with an explicit deduction schedule.
- **No player-funds custody** — the operator's wallet stays authoritative.

Companion documents: `sla.md` (service-level draft),
`aggregator-readiness-checklist.md` (onboarding gates), `compliance-roadmap.md`
(capability status), `../api-integration-spec.md` (technical integration).
