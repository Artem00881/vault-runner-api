# Vault Run — Sub-processor Inventory

**Version:** 1.0  ·  **Date:** 2026-06-08  ·  **Audience:** operators, aggregators, data-protection officers / procurement

This is the **current list of sub-processors** Vault Run (the **processor**) engages
to deliver the RGS to operators (each a **controller**). It satisfies the
sub-processor transparency and **prior-notice-of-change** commitment in the Data
Processing Agreement (`dpa-template.md` §5(d), GDPR Art. 28(2)/(4)).

> **Grounding note.** Every entry below is verified against the repository and ops
> runbooks (`DEPLOY.md`, `docker-compose*.yml`, `src/observability/sentry.ts`,
> `.env.production.example`, the ops runbook). We do **not** list a provider we do
> not actually use. In particular: the RGS application code (`src/`) contains **no
> object-store / S3 / R2 client at runtime** — the only use of object storage is the
> **encrypted off-site backup** pipeline (Cloudflare R2), which stores **ciphertext
> only** (see note 2 below).

---

## 1. Sub-processor inventory

| # | Sub-processor | Role / purpose | Personal data processed | Region | Safeguard |
|---|---|---|---|---|---|
| 1 | **Vultr (The Constant Company, LLC)** | Production VPS hosting — runs the RGS application + its PostgreSQL and Redis (self-managed on the box). | The full pseudonymous data set at rest/in-process (pseudonymous `playerId` + derived `username`/`displayName`, `locale`, game/financial records). **No** name/email/payment/KYC. | **EU** (production region; confirmed per deployment). | DPA / SCCs with the hosting provider; EU region; mTLS-only origin reachable only via Cloudflare. |
| 2 | **Hetzner Online GmbH** | Staging + the **hosted operator-mode sandbox** (`https://sandbox.vaultrun.app`) VPS hosting. | Sandbox/staging only — the sandbox runs a **play-money stub wallet** (no real-money operator player identity); staging holds test data. | **Germany (EU)** — Falkenstein. | EU data centre; provider DPA. Sandbox/staging are **not** production and not under the production SLA (`sla.md` §9). |
| 3 | **Cloudflare, Inc.** | Edge / CDN / WAF / TLS termination in front of the origin; supplies the trusted client IP (`CF-Connecting-IP`) used for rate limiting; Authenticated Origin Pull (mTLS) to the origin. | **Transit only** — request metadata incl. client IP at the edge. Vault Run uses the IP only as an **in-memory** rate-limit key; it is **not persisted** by the RGS. | Global (anycast edge). | Cloudflare DPA + SCCs; EU origin behind it; TLS in transit. |
| 4 | **Cloudflare R2 (Cloudflare, Inc.)** | **Encrypted off-site database backups** only (DR). Stores the `pg_dump` snapshots written by the backup pipeline. | The database snapshot **as ciphertext** — see note 2. No plaintext personal data is exposed to R2. | Global / EU-selectable bucket. | Backups are **client-side `age`-encrypted before upload** (private key held off-server in 1Password). R2 holds ciphertext only; DPA/SCCs apply. |
| 5 | **Sentry (Functional Software, Inc.)** | Application **error tracking** — **active only when `SENTRY_DSN` is configured** (a no-op otherwise; `src/observability/sentry.ts`). Errors only; no performance tracing. | Exception/diagnostic data. **No player personal data is intentionally sent**; stack traces could incidentally contain a pseudonymous id. Configured for errors only, sampled at 100% of errors / 0% traces. | US / EU (Sentry region per project). | Sentry DPA + SCCs; minimize captured context; disabled unless explicitly enabled. |
| 6 | **1Password (AgileBits Inc.)** | **Secret management** — production secrets (DB password, JWT secret, Sentry DSN, backup key copy) injected at deploy time. | **No player personal data** — secrets/credentials only. | US/CA/EU (vault region). | 1Password DPA; secrets only, never player data; access-controlled vault. |

> **The self-managed datastores (PostgreSQL, Redis) are NOT separate sub-processors** —
> they run **inside** the Vultr/Hetzner VPS (rows 1–2), under Vault Run's control, not
> as a third-party managed service. They are listed here for completeness, not as
> additional processors. (A future move to a **managed** Postgres/Redis would add a
> sub-processor and trigger the §3 change notice.)

---

## 2. Notes & exact scoping

1. **Edge IP is transit-only.** Cloudflare (row 3) sees the client IP at the edge and
   passes it to the origin as `CF-Connecting-IP`. The RGS reads it **only** as an
   in-memory rate-limit bucket key (`src/common/client-ip.ts` + the throttler) and
   **never writes it to PostgreSQL**. There is no persistent player-IP store in the RGS.
2. **Backups are ciphertext at the sub-processor.** The backup pipeline runs
   `pg_dump` → **`age` client-side encryption** → upload to **Cloudflare R2** (row 4).
   The decryption private key is held **off-server** (1Password + a second independent
   copy) and is **never** uploaded. R2 therefore holds only **encrypted** snapshots;
   the snapshot contents are the pseudonymous data set (no name/email/payment/KYC).
3. **Error tracking is opt-in and minimized.** Sentry (row 5) is a **no-op unless
   `SENTRY_DSN` is set**, captures **errors only** (no transaction/PII payloads by
   design), and is the only reason a pseudonymous id could *incidentally* leave the
   primary infrastructure (in a stack trace). If a deployment runs without Sentry, the
   list is rows 1–4 + 6.
4. **No object/blob store at runtime.** Confirmed by code scan: there is **no
   S3/R2/aws-sdk client in `src/`**. Object storage (R2) is used **only** by the DR
   backup pipeline (row 4). We list it because the *backups* are a data flow that
   leaves the origin — not because the application writes player data to a bucket.
5. **No analytics / marketing / ad sub-processors.** Vault Run runs no third-party
   analytics, advertising, A/B-testing, CRM, or marketing tooling on the player path.

> **A note on the frontend demo (out of RGS scope).** The public **play-money demo**
> front-end (a separate web project) uses **Supabase** as a demo-only datastore,
> **RLS-locked**, holding **no real-money operator player identity** (guest play
> only). It is **not part of the operator RGS data flow** documented here and is not a
> sub-processor for an operator's real-money players. It is mentioned only to be
> exhaustive; for an operator integration it does not apply.

---

## 3. Change notification (Art. 28(2))

Vault Run gives operators **prior written notice** of any intended **addition or
replacement** of a sub-processor, with a reasonable period (default **[30] days**, set
in the signed DPA) for the operator to **object on reasonable data-protection
grounds**. Each new sub-processor is bound, by contract, to **data-protection
obligations no less protective** than those in `dpa-template.md`, and Vault Run
remains **fully liable** to the operator for its sub-processors (`dpa-template.md`
§5(d)).

- **How notice is given:** via the agreed contact channel in the master agreement /
  DPA (and, where maintained, an updated revision of this document).
- **This list is the canonical current state**; the version/date header above marks
  the last change.

---

Companion documents: `dpa-template.md` (the DPA, §5(d) sub-processor terms),
`data-protection-policy.md` (record of processing + retention), `sla.md` §8
(security & edge architecture), `../api-integration-spec.md` §17 (data protection).
