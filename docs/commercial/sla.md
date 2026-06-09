# Vault Run — Service Level Agreement (DRAFT)

**Version:** 1.0  ·  **Date:** 2026-06-07  ·  **Audience:** operators, aggregators, procurement / legal

> **THIS IS A NEGOTIABLE DRAFT.** It states the service levels Vault Run proposes
> to commit to as the RGS provider; it is **not yet a signed, binding SLA**. All
> targets, tiers, windows, and credits below are a **starting point for
> negotiation** and become contractual only when agreed and executed in a signed
> services agreement. Specific figures (uptime %, response times, credit ladder)
> are subject to change per deal.
>
> **Sourcing note.** No public **igaming-specific** SLA template was found in our
> research. The targets here mirror **general cloud / SaaS / datacenter norms**
> that igaming buyers apply (uptime tiers, P1–P4 response benchmarks, service-credit
> ladders). They are the benchmarks our buyers expect — not a citation that "RGS
> providers guarantee X." Latency and maintenance-window figures are set from
> **Vault Run's own load-test metrics**, not copied from a generic source.

This SLA covers the Vault Run Remote Game Server (RGS) and its seamless-wallet,
WebSocket game, reporting, and provably-fair surfaces (`../api-integration-spec.md`).

---

## 1. Definitions

| Term | Meaning |
|---|---|
| **Service** | The Vault Run RGS: the launch endpoint, WebSocket game protocol, the seamless-wallet calls the RGS makes to the operator, the reporting API, and the public fairness/round-history endpoints. |
| **Money path** | The settlement-critical operations: stake debit, payout credit, rollback, and the cash-out/settlement pipeline. Held to the higher availability target (§2). |
| **Availability / Uptime** | The percentage of time in a calendar month the Service is operational, **excluding** agreed scheduled maintenance and excluded events (§7, §9). |
| **Downtime** | A period in which the Service is not operational for reasons within our control and outside the exclusions (§9). |
| **Incident** | An unplanned degradation or unavailability of the Service, classified P1–P4 (§4). |
| **Response time** | Time from a qualifying incident being **reported through the agreed channel** to our **first substantive human acknowledgement** and start of triage (not time to full resolution). |
| **Service credit** | The remedy for a missed monthly uptime target, expressed as a % of the monthly fees for the affected service (§6). |
| **Monthly fees** | The fees attributable to the affected month. For a pure rev-share deal (`revenue-share-model.md`) the credit base is defined in the commercial schedule (e.g. the month's royalty), since there is no fixed subscription fee. |

---

## 2. Availability targets

| Scope                                                     | Target                    | Approx. allowed downtime             |
|-----------------------------------------------------------|---------------------------|--------------------------------------|
| **Overall Service**                                       | **99.9%** ("three nines") | ≈ 43 min / month (≈ 8.7 h / year)    |
| **Money path** (settlement-critical, multi-node topology) | **≥ 99.95%**              | ≈ 21.6 min / month (≈ 4.4 h / year)  |

> **What is benchmarked vs. a Vault Run convention.** The headline figures here —
> **99.9% uptime**, the **P1–P4** response tiers, and the **5–25% service-credit
> ladder** — are directly anchored to general cloud / SaaS norms that igaming buyers
> apply. The remaining specifics — the exact credit breakpoints, the **99.95%
> money-path target**, the **≥ 72 h** maintenance-notice default, and the
> **~5-business-day** RCA window — are **Vault Run conventions aligned to common
> practice but not drawn from a specific published SLA**. All remain negotiable.

- **99.9%** is the prevailing business-critical cloud/SaaS target and our headline
  commitment for the Service overall. It is also the **interim target for the
  current single-node production deployment** (overall Service and money path
  alike).
- The **money path** carries a higher **≥ 99.95%** target **for the multi-node
  topology** (leader election + seamless failover; see §8 and
  `../api-integration-spec.md`). That multi-node topology is **designed and
  deployed single-node today but not yet load-run end-to-end at scale**; until it
  is in production, the interim money-path commitment is the **99.9%** overall
  figure. A **99.99%** money-path tier may be discussed as a **premium option**
  where the deployment topology (multi-node, managed datastores) supports it; we do
  **not** commit 99.99% in this draft.
- Availability is measured per calendar month, in UTC, excluding scheduled
  maintenance (§7) and excluded events (§9).

> For reference (downtime-per-target math, general cloud norms): 99.9% ≈ 43
> min/month; 99.95% ≈ 21.6 min/month; 99.99% ≈ 4.4 min/month; 99.999% ≈ 26
> sec/month (five-nines is rarely promised at the application layer and is **not**
> offered here).

---

## 3. Performance / latency

Latency commitments are derived from Vault Run's own load tests, not a generic
benchmark:

| Metric | Target | Basis |
|---|---|---|
| **Settlement p99** (cash-out / payout processing) | **< 200 ms** | Held under single-node load up to the connection knee below (the box stayed ~90% idle — the ceiling was an application-level lock, not CPU). Measures **RGS-internal** settlement processing and **excludes** the operator's wallet round-trip (see the scope note below). |
| **Concurrent connections per node — internal (play-money) mode** | ≈ **4,400** (single-node) | Vault Run internal load tests, 2026-06 (Hetzner, single-node). |
| **Concurrent connections per node — operator (seamless-wallet) mode** | ≈ **3,800–4,000** (single-node, conservative lower bound) | Same tests; the operator figure is a **lower bound** — the load generator was saturated during that run. |

- These figures are from **Vault Run internal load tests, 2026-06 (Hetzner,
  single-node); methodology and raw results available on request under NDA.** They
  are **single-node** results: the HA topology (leader election + seamless failover)
  is implemented and **deployed single-node on production**, but **multi-node has
  not yet been load-run end-to-end at scale**, so cluster sizing is by design, not
  yet measured.
- These are **performance objectives** measured under representative load; the
  binding **availability** commitment is §2. Latency targets are set as objectives
  here and can be elevated to measured SLOs with agreed measurement methodology in
  a signed SLA.
- No public crash-game tick-latency SLA number exists; the settlement-p99 figure is
  **our own measured value**, which is the correct basis for a real-time game.
- **Scope of the settlement p99.** The settlement p99 < 200 ms measures
  **RGS-internal** settlement processing (the cash-out/payout path inside our engine
  and ledger) and **excludes the operator's wallet round-trip** (your `/win` /
  `/rollback` latency). It was measured single-node against a zero-latency wallet
  stub, so it isolates our own processing time. An **end-to-end** SLO that includes
  the operator wallet RTT would be defined against an agreed measurement point in a
  signed SLA.

---

## 4. Support response tiers

Severity is assessed on **business impact**, not on which component is involved.
Response time = time to first substantive human acknowledgement and start of
triage (§1), measured from a report via the agreed channel.

| Severity | Definition | Target response |
|---|---|---|
| **P1 — Critical** | Service or money path down / unusable for the operator; settlement broken; security incident affecting funds or data. | **15–30 minutes**, 24/7 |
| **P2 — High** | Major function degraded with no acceptable workaround; significant subset of players affected; reporting/reconciliation materially impaired. | **1–2 hours** |
| **P3 — Medium** | Partial / non-critical impairment with a workaround; minor functional defect. | **4–8 hours** |
| **P4 — Low** | Question, cosmetic issue, documentation, or feature request. | **1 business day** |

- **Coverage:** P1 is handled **24/7**. P2–P4 windows and out-of-hours coverage for
  lower severities are set per deal (e.g. business hours for P3/P4).
- **Escalation:** unresolved P1/P2 incidents follow an agreed escalation path
  (named contacts, periodic status updates until resolution).
- **Channels:** the qualifying report channel (e.g. a dedicated email/queue or
  on-call contact) is agreed at onboarding; only reports via that channel start the
  response clock.

---

## 5. Incident handling & RCA

- **Acknowledgement & triage:** on a qualifying report we acknowledge within the
  §4 target, classify severity, and begin triage.
- **Status updates:** for P1/P2, we provide periodic status updates at an agreed
  cadence until the incident is resolved or downgraded.
- **Restoration before root cause:** our first priority is restoring service
  (including via the seamless-failover path, §8); permanent fixes follow.
- **Money-path integrity:** because every money move is idempotent and ambiguous
  debits are compensated by rollback (`../api-integration-spec.md` §9), an incident
  on the money path resolves to a **reconcilable** state — no silent double-charge
  or lost payout. Post-incident reconciliation uses the §10/§13 invariants in the
  API spec.
- **Root-Cause Analysis (RCA):** for every **P1** (and material **P2**) we provide
  a written RCA — typically within **5 business days** of resolution — covering
  impact, timeline, root cause, remediation, and preventive actions.
- **Monitoring & detection:** we run continuous monitoring and error tracking
  (Sentry) with alerting (§8), so detection is generally proactive rather than
  reliant on operator reports.

---

## 6. Service credits

A missed **monthly uptime target** (§2) entitles the operator to a service credit,
applied against the affected month's fees, on request within an agreed claim window.
The ladder mirrors common cloud/SaaS practice (tiered to how far below target the
month fell):

| Monthly availability (Overall Service) | Service credit (% of monthly fees) |
|----------------------------------------|------------------------------------|
| ≥ 99.9% (target met)                   | 0%                                 |
| 99.0% – < 99.9%                        | **5%**                             |
| 95.0% – < 99.0%                        | **10%**                            |
| 90.0% – < 95.0%                        | **15%**                            |
| < 90.0%                                | **25%**                            |

- **Money-path credits.** A breach of the **≥ 99.95%** money-path target uses an
  equivalent ladder, agreed per deal (the money path is the more sensitive metric).
- **Sole and exclusive remedy.** Service credits are the sole remedy for missed SLA
  targets. As is standard, **credits are a remedy, not full compensation for
  business losses** — they typically do not cover an operator's lost revenue from
  an outage; broader liability is governed by the master agreement.
- **Claim process & caps:** credits are requested within an agreed window after the
  affected month, are calculated on the affected month's fees, and are subject to a
  monthly cap (e.g. the credit ladder maxes at 25%). For a pure rev-share deal the
  fee base for credits is defined in the commercial schedule (§1).
- **Rev-share credit base.** In a pure rev-share model the service credit is a
  **percentage of the affected month's Vault Run royalty (our GGR share) and cannot
  exceed it.** It is **not** calculated on the operator's turnover, GGR, or losses —
  only on the royalty we would otherwise have earned that month.
- **Exclusions reduce/void credits** where downtime stems from an excluded event
  (§9).

---

## 7. Scheduled maintenance

- **Excluded from uptime.** Maintenance announced within the agreed notice window
  does **not** count as downtime (standard SLA carve-out).
- **Notice.** We provide advance notice for planned maintenance — proposed default
  **≥ 72 hours** for standard maintenance.
- **Windows.** Maintenance is scheduled in agreed **low-traffic windows** (e.g.
  off-peak UTC hours) and kept as short as practical.
- **Emergency maintenance.** Security or stability-critical emergency maintenance
  may be performed with shorter or immediate notice; we notify as early as
  practical and document it. Emergency maintenance handling (and whether it counts
  toward uptime) is defined in the signed SLA.

---

## 8. Monitoring & observability

- **Continuous monitoring** of the Service with alerting to our on-call (incidents
  surface to operations, e.g. via Telegram alerting) and **error tracking via
  Sentry**.
- **High-availability design:** leader election with **seamless failover** — on a
  node failure a survivor resumes the in-flight round; the money path is
  multi-node-safe and failover is designed to be seamless. **Deployed single-node on
  production today; the multi-node topology is designed but not yet load-run
  end-to-end at scale.** See `../api-integration-spec.md`.
- **Metrics** include settlement latency (p99) and connection counts (§3); a
  bearer-locked metrics endpoint and health checks back operational monitoring.
- **Edge & transport security:** Cloudflare + Caddy with mTLS in front of the RGS;
  PostgreSQL + Redis as datastores.
- **Status communication:** incident status is communicated through the agreed
  channel during P1/P2 events (§5). A formal public status page can be added per
  deal.

---

## 9. Scope & exclusions

This SLA covers the Vault Run RGS as defined in §1. Availability and credits do
**not** apply to downtime or degradation caused by:

- **Scheduled / announced maintenance** (§7) and agreed emergency maintenance.
- **The operator's own systems** — including the operator's **seamless-wallet
  endpoints** (`/bet` `/win` `/rollback` `/balance`), lobby, launch-token signing,
  network, or infrastructure. The RGS depends on the operator's wallet being
  available; operator-side wallet outages are excluded from our uptime (though our
  idempotency/rollback semantics keep the money state reconcilable —
  `../api-integration-spec.md` §9).
- **Third-party / upstream providers** outside our reasonable control (e.g. cloud
  region outage, DNS/CDN provider incident, public Ethereum RPC availability for
  the optional block-salt oracle — which transparently falls back to a random salt
  rather than stalling the game, `../provably-fair-guide.md` §8).
- **Force majeure** and events beyond our reasonable control.
- **Misuse** — use outside the documented API contract, the operator's failure to
  implement idempotency/rollback correctly, exceeding agreed rate limits
  (`../api-integration-spec.md` §6: per-socket 15 msg/s; per-operator limits), or
  unauthorized modifications.
- **Beta / sandbox environments.** The hosted operator-mode sandbox — **live** at
  `https://sandbox.vaultrun.app` (`compliance-roadmap.md`) — is provided for
  integration testing and is **not** covered by production SLA targets.

---

## 10. Review & changes

- This SLA is reviewed periodically and may be revised by agreement; the binding
  version is the one in the executed services agreement.
- Material changes to targets, tiers, or credits require mutual written agreement.
- This draft is internally consistent with the reliability and money-safety claims
  in `../api-integration-spec.md` and the commercial model in
  `revenue-share-model.md`.

---

## 11. Summary of proposed levels (negotiable)

| Item                       | Proposed level                                                                            |
|----------------------------|-------------------------------------------------------------------------------------------|
| Overall uptime             | **99.9%** / month                                                                         |
| Money-path uptime          | **≥ 99.95%** / month (multi-node topology target; **interim single-node target = 99.9%**) |
| Settlement p99 (objective) | **< 200 ms** (single-node load tests)                                                     |
| P1 response                | **15–30 min**, 24/7                                                                       |
| P2 response                | **1–2 h**                                                                                 |
| P3 response                | **4–8 h**                                                                                 |
| P4 response                | **1 business day**                                                                        |
| Maintenance notice         | **≥ 72 h** (standard); emergency as needed                                                |
| Service credits            | **5% / 10% / 15% / 25%** of monthly fees, tiered                                          |
| RCA                        | Written RCA for P1 (and material P2), ~5 business days                                    |

> Every figure above is a **negotiable draft proposal**, mirroring general
> cloud/SaaS norms, with latency/connection figures from Vault Run's own load
> tests. Final, binding levels are set in the signed services agreement.
