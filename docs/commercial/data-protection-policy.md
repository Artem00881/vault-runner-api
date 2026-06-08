# Vault Run — Data Protection Policy (Processor)

**Version:** 1.0  ·  **Date:** 2026-06-08  ·  **Audience:** operators, aggregators, data-protection officers / compliance / legal

This policy states how Vault Run, acting as a **processor** for the operator (the
**controller**), handles personal data in the Remote Game Server (RGS). It provides
(A) the processor **record of processing** (GDPR Art. 30(2)), (B) the **retention
schedule** and the anonymize-not-delete policy, (C) the **data-subject-rights**
handling flow, and (D) the exhaustive **"process / never store"** appendix.

Every claim here is grounded in what the RGS **actually stores** — verified against
`prisma/schema.prisma`, `src/operator/game-session.service.ts`, and
`src/common/client-ip.ts`. Companion documents: `dpa-template.md` (the DPA),
`sub-processors.md` (sub-processor inventory), `../api-integration-spec.md` §17
(technical split), `sla.md` §8 (security), `compliance-roadmap.md` (status).

> **Roles.** The **operator is the controller** (owns the player relationship,
> KYC/AML, funds, account-level RG). **Vault Run is the processor** — it operates the
> game and settles via the operator's seamless wallet, holding only a **pseudonymous**
> view of the player. Vault Run **never holds player funds** and **never sees a
> funding instrument**.

---

## A. Record of processing (Art. 30(2))

A single processing activity: **operating the Vault Run crash RGS on the operator's
documented instructions.**

| Field | Detail |
|---|---|
| **Processor** | Vault Run [legal entity], [contact / DPO]. |
| **Controller(s) on whose behalf** | Each operator that integrates the RGS (see the signed DPA per operator). |
| **Purpose of processing** | Operate the crash RGS; settle stakes/payouts against the operator's seamless wallet; provide reporting & reconciliation; enforce session-scoped responsible gambling. No profiling, advertising, or automated decision-making with legal effect. |
| **Categories of data subjects** | The operator's **players** who launch the game (identified to us only by the operator's pseudonymous `playerId`). |
| **Categories of personal data** | Pseudonymous `playerId`; derived `username` (`op:{operatorId}:{playerId}:{currency}`) and `displayName` (`Player <playerId[0:6]>`); session `locale`; operator-scoped game/financial records (bets, rounds, cash-outs, local money journal in integer minor units) linked to the pseudonymous id; transient client IP **in memory only** (rate-limit key, never stored). **Special categories (Art. 9): none.** |
| **Recipients** | The **operator** (controller); the **sub-processors** in `sub-processors.md` (hosting, edge/CDN, error tracking when enabled, secret manager, encrypted backup store). No other disclosure except where required by law. |
| **Third-country transfers** | Hosting is **EU** (production on Vultr; staging/sandbox on Hetzner, Germany). Edge/CDN (Cloudflare), error tracking (Sentry, when enabled) and the encrypted backup store (Cloudflare R2) may involve transfers covered by **SCCs** / the provider's transfer framework — see `sub-processors.md`. |
| **Retention** | Per §B: identity is **anonymized**; the de-identified financial/round record is **retained** for the controller's statutory hold (Art. 17(3)(b)/(e)). |
| **Security measures (Art. 32)** | Data minimization + pseudonymization; mTLS Cloudflare+Caddy edge (origin not directly reachable); bearer-locked metrics; per-socket (15 msg/s) and (forthcoming) per-operator rate limits; signed short-lived (120 s, single-use) launch tokens + revocable session tokens; secrets in 1Password (never in source); client-side-encrypted off-site backups with tested restore; append-only significant-event audit log (no player IP). See `sla.md` §8. **Honest scope:** internal adversarial audit + remediation on record; **no third-party pentest / ISO 27001 yet** (`compliance-roadmap.md`). |

---

## B. Retention schedule

These are Vault Run's **defaults / maximums as a processor, absent a different
documented instruction from the controller.** The operator, as controller, may set a
shorter or (where its own law requires) longer period; the **operator's instruction
governs** its own statutory duties.

| Data | Retention (default) | Basis / rationale |
|---|---|---|
| **Financial ledger + bets** (`ledger_transactions`, `game_bets`) | **≥ 5 years** after the transaction, de-identified on erasure (see anonymize-not-delete below). | AML / bookkeeping & tax record-keeping; the **controller's legal hold**. Legal basis to retain past an erasure request: **GDPR Art. 17(3)(b)** (legal obligation) and **Art. 17(3)(e)** (legal claims / disputes). |
| **Game rounds + fairness records** (`game_rounds`, `fairness_chains`, `fairness_seeds`) | **Retained with the financial ledger** (same window). | Integrity of the provably-fair record and reconciliation; these underpin every settled bet. No direct player identity (linked only via the bet). |
| **Significant-event audit log** (`audit_events`) | **Long-term / immutable** (append-only; app role cannot update/delete in production). | Certification & accountability ("who did what, when"). **Contains no player IP**; the only IP captured is the **operator's caller IP** on an operator-initiated HTTP action (operator staff/system, not a player). |
| **Player identity** (`users.username`, `profiles.display_name`, `game_sessions.player_id`) | **Anonymized** on a controller erasure request, **or** after a defined dormancy period **[e.g. 24 months]** with no activity. | Data minimization / storage limitation (Art. 5(1)(e)). Anonymization severs the link to the operator's player while preserving the de-identified financial record. |
| **Game sessions** (`game_sessions`) | **Short** — kept for the session lifecycle + reconciliation; the `player_id` is tombstoned on identity erasure. | Operational; session tokens are short-lived (default 4 h) and revocable. |
| **Transient rate-limit IP** | **Ephemeral — in memory only**; never persisted, evicted as the throttler window rolls. | Security (rate limiting). Not written to the database at all (`src/common/client-ip.ts`). |
| **Application logs / Sentry** | **30–90 days** (typical), errors only; Sentry only when enabled. | Operational diagnostics; minimized (no PII payloads by design). |
| **Encrypted off-site backups** | Rolling **30 days** (then deleted), client-side `age`-encrypted (ciphertext at the store). | Disaster recovery; `sub-processors.md` note 2. |

**Anonymize-not-delete policy.** Vault Run erases **identity** rather than deleting
the **financial record**. On a controller erasure instruction (or at end-of-dormancy),
the identity strings are tombstoned in place — `users.username` → `anon:<hash>`,
`profiles.display_name` → `anon`, `game_sessions.player_id` → tombstone — and
`users.anonymized_at` is stamped (the `anonymized_at` column exists in the schema for
exactly this). The BigInt money journal and the round/fairness records are **retained,
de-identified**, for the statutory AML/bookkeeping window on the legal basis **Art.
17(3)(b)/(e)**. This satisfies the right to erasure while honouring the controller's
overriding legal obligation to keep transaction records.

> **Future item (honest status).** A **scheduled retention sweep** that auto-anonymizes
> at end-of-dormancy is **not yet built** — today, retention/erasure is **operator-
> initiated** (the controller routes a request to us, §C). The dormancy figures above
> are the **proposed defaults**; the sweep is a planned addition.

---

## C. Data-subject-rights handling flow

Because Vault Run holds only the **pseudonymous** `playerId`, it **cannot identify a
data subject by real-world identity** — only the **operator (controller)** can resolve
`playerId` to a person and authenticate the request. The flow:

1. **The player exercises a right with the operator** (access, rectification, erasure,
   restriction, portability, objection). The operator verifies the requester's identity
   (it holds the KYC).
2. **The operator routes the request to Vault Run**, referencing the **`playerId`** (and
   currency/operator scope). This is the documented instruction (`dpa-template.md` §5(e)).
3. **Vault Run executes it tenant-scoped** — strictly within that operator's data
   (`operatorId`), never across tenants. For **erasure**, this is the
   **anonymize-in-place** operation in §B.
4. **Settled-state precondition.** Erasure/anonymization runs only on a player whose
   money is at rest — no open bet or in-flight settlement (so a reversal/reconcile can
   never resurrect identity after the fact). In-flight money must settle first.
5. **The action is audit-logged** in the append-only `audit_events` log (actor,
   action, tenant, timestamp), so the operator has an accountability record that the
   request was carried out.
6. **Turnaround.** Vault Run actions a valid, in-scope request **within [10] business
   days** (set in the DPA), and confirms completion to the operator, who responds to the
   player within its own statutory deadline (Art. 12(3): generally one month).

> **Mechanism today.** The trigger is **operator-initiated** and executed by Vault Run
> via an **internal operator-initiated process** (tenant-scoped). A **self-service
> operator HTTP endpoint** for erasure is **deferred** behind the same prerequisites as
> the other operator money-write surface — a **per-operator rate limit** and a
> **read-vs-write key-scope** decision (`../api-integration-spec.md` §13.3, §17). Until
> then, requests are handled via the agreed support channel.

**Access / portability.** For access or portability of the records we hold, Vault Run
provides the operator the pseudonymous data set linked to that `playerId` (game/
financial records); the operator combines it with the identity it holds to respond to
the player. **Rectification** of identity fields is generally a no-op for us (we store
only a truncated display name derived from the operator's id); the operator corrects
the source `playerId`/identity on its side.

---

## D. Appendix — personal data we process / never store

> This is the **complete, code-grounded** statement. It is the single source of truth
> reused verbatim across the DPA (`dpa-template.md` §4/§9) and the integration spec
> (`../api-integration-spec.md` §17).

### Personal data Vault Run **processes** (the entire list)

| Data | Form | Storage |
|---|---|---|
| **Pseudonymous player id** | The operator's own `playerId` (a token meaningful only to the operator). | `game_sessions.player_id`; embedded in `users.username` = `op:{operatorId}:{playerId}:{currency}` (`…:demo` for fun-mode). |
| **Derived display name** | `Player <first 6 chars of playerId>`. | `profiles.display_name`. |
| **Session locale** | UI language hint (e.g. `en`). | `game_sessions.locale`. |
| **Operator-scoped game/financial records** | Bets, rounds, cash-outs, local money journal — integer minor units, linked to the pseudonymous id. | `game_bets`, `game_rounds`, `wallets`, `ledger_transactions`. |
| **Transient client IP** | Real client IP (via `CF-Connecting-IP`), used **only** as a rate-limit bucket key. | **In memory only — never written to the database** (`src/common/client-ip.ts`). |

### Personal data Vault Run **NEVER stores**

- Real name, email address, phone number, postal address;
- Date of birth / age;
- Government ID, KYC documents, proof of address;
- **Payment instrument — card number, bank account, crypto wallet address** (the
  seamless-wallet model means we never hold player funds and never see a funding
  instrument);
- Marketing / behavioural profile, persistent geolocation;
- Any **special-category** (Art. 9) data.

The operator, as controller, holds all of the above. Vault Run's view of the player is
**pseudonymous by design** — confirmed by a full scan of the database schema
(`prisma/schema.prisma`: `User`, `Profile`, `GameSession`, `Bet`, `Wallet`,
`Operator`), which contains **no column** for any item on the "never store" list.

---

## E. KYC / AML boundary

KYC, AML, age/identity verification, and **account-level** responsible gambling
(self-exclusion, deposit/loss limits across the account) are the **operator's**
responsibility as controller — the operator simply does not mint a launch token for an
excluded or unverified player. Vault Run enforces only the **session-scoped** RG the
operator configures (reality checks, session time/loss/wager limits;
`../api-integration-spec.md` §11, `src/operator/rg-config.ts`). This boundary is why
Vault Run needs none of the identity/payment data above.

---

Companion documents: `dpa-template.md`, `sub-processors.md`, `sla.md` §8,
`compliance-roadmap.md`, `aggregator-readiness-checklist.md`,
`../api-integration-spec.md` §17.
