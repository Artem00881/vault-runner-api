# Vault Run — Data Processing Agreement (TEMPLATE)

**Version:** 1.0  ·  **Date:** 2026-06-08  ·  **Audience:** operators, aggregators, procurement / legal / data-protection officers

> **THIS IS A SIGNABLE TEMPLATE, NOT LEGAL ADVICE AND NOT YET AN EXECUTED
> AGREEMENT.** It is drafted to satisfy **Article 28(3) GDPR** for the specific,
> narrow processing Vault Run performs as a **processor** for the operator
> (**controller**). Bracketed `[…]` fields are completed per deal. The binding
> version is the one signed by both parties (typically as an annex to the master
> services / RGS agreement). Have your own counsel review it. Where this template
> and the operative master agreement differ, the **signed master agreement
> governs**.

This DPA is grounded in what the Vault Run RGS **actually stores** — verified
against `prisma/schema.prisma` and `src/operator/game-session.service.ts`. The
categories of personal data below are deliberately minimal; see the appendix and
`data-protection-policy.md` for the exhaustive "process / never store" lists.

Companion documents: `data-protection-policy.md` (record of processing +
retention schedule), `sub-processors.md` (the current sub-processor inventory),
`../api-integration-spec.md` §17 (the technical controller/processor split),
`sla.md` §8 (security controls), `compliance-roadmap.md` (GDPR/DPA status).

---

## 1. Parties and roles

| | Controller | Processor |
|---|---|---|
| **Party** | **[Operator legal entity]**, [registration no.], [registered address] ("**Operator**") | **[Vault Run legal entity]**, [registration no.], [registered address] ("**Vault Run**") |
| **Role (GDPR)** | **Controller** — determines the purposes and means of processing the players' personal data; owns the player relationship, KYC/AML, and account-level responsible gambling. | **Processor** — processes personal data **only on the Operator's documented instructions** to deliver the Remote Game Server (RGS). |
| **Contact / DPO** | [name · email] | [name · email] |

- The Operator is the **controller** of its players' personal data. The Operator
  decides who may play, holds the player account and funds, and performs identity
  verification (KYC) and anti-money-laundering (AML) checks. Vault Run never has a
  direct relationship with the player.
- Vault Run is the Operator's **processor**. Vault Run operates a server-authoritative
  crash game and settles each stake/payout against the **Operator's own seamless
  wallet** (`../api-integration-spec.md` §7). Vault Run **does not hold player funds**
  and **does not see any funding instrument**.
- The controller/processor split is also recorded in `src/operator/rg-config.ts`
  (the Operator owns account-level RG/self-exclusion; Vault Run enforces only
  session-scoped controls) and in `../api-integration-spec.md` §1.

---

## 2. Subject-matter, duration, nature and purpose

| Item | Detail |
|---|---|
| **Subject-matter** | Processing of the Operator's players' personal data strictly as needed to provide the Vault Run RGS (the crash game, settlement against the Operator's wallet, reporting/reconciliation, and session-scoped responsible-gambling controls). |
| **Duration** | For the term of the master services / RGS agreement, plus the retention windows in `data-protection-policy.md` (financial/game-round records are retained for the controller's statutory hold; identity data is anonymized — see §9). |
| **Nature of processing** | Collection (from the signed launch token), storage (a pseudonymous local journal), use (running rounds, settling money via the Operator wallet, generating reports, enforcing session RG), and erasure-by-anonymization on instruction. |
| **Purpose** | (1) Operate the crash RGS; (2) settle stakes/payouts via the Operator's seamless wallet; (3) provide reporting & reconciliation to the Operator; (4) enforce the session-scoped RG the Operator configures. No profiling, no advertising, no automated decision-making with legal effect on the player. |

---

## 3. Categories of data subjects

- **The Operator's players** who launch the Vault Run game from the Operator's
  lobby (each identified to Vault Run only by the Operator's own pseudonymous
  `playerId`).

No other category of data subject is processed. Vault Run does not process data of
the Operator's non-playing customers, staff (beyond the Operator's own integration
contacts named in the agreement), or any third party.

---

## 4. Categories of personal data

Vault Run processes a **deliberately minimal, pseudonymous** set. The complete,
code-grounded inventory:

| Category | What it is | Where it lives | Notes |
|---|---|---|---|
| **Pseudonymous player id** | The Operator's own `playerId` from the signed launch token. | `game_sessions.player_id`; embedded in the derived `users.username` (`op:{operatorId}:{playerId}:{currency}`) and used for the display name. | A token meaningful **only to the Operator**; Vault Run cannot resolve it to a natural person. |
| **Derived display name** | `Player <first 6 chars of playerId>` (e.g. `Player ab12cd`). | `profiles.display_name`. | Leaderboard label; a truncated derivative of the pseudonymous id. |
| **Session locale** | A BCP-47-ish UI language hint (e.g. `en`). | `game_sessions.locale`. | Not directly identifying. |
| **Operator-scoped game/financial records** | Bets, rounds, cash-outs, and the local money journal, keyed to the pseudonymous player. | `game_bets`, `game_rounds`, `wallets`, `ledger_transactions`. | Personal data only by linkage to the pseudonymous `playerId`; the money figures are integer minor units (no card/bank/crypto-address data). |
| **Transient rate-limit IP** | The real client IP, used **only in memory** as a rate-limit bucket key. | **Not persisted** — in-memory throttler only (`src/common/client-ip.ts`). | Derived from `CF-Connecting-IP` behind the edge; never written to the database. |

**Special categories (Art. 9).** None. Vault Run does not process any special-category
data.

**Explicitly NEVER processed or stored** (see the appendix and
`data-protection-policy.md`): real name, email, phone, postal address, date of
birth, government ID / KYC documents, **payment instrument — card / bank account /
crypto wallet address**, marketing profile, or persistent geolocation. The
seamless-wallet model means Vault Run never holds player funds and never sees a
funding instrument. The Operator, as controller, holds all of these.

---

## 5. The processor's obligations — Article 28(3)(a)–(h)

Vault Run, as processor, undertakes the following. Each maps to the lettered
sub-obligation of Art. 28(3).

### (a) Process only on documented instructions
Vault Run processes the personal data **only on the Operator's documented
instructions** — this DPA and the master agreement being the initial documented
instruction, supplemented by the API integration (`../api-integration-spec.md`),
the provisioning configuration (currencies, limits, RG config), and any later
written instruction. This includes transfers to a third country only where the
Operator has instructed it or it is required by law (then Vault Run informs the
Operator first, unless legally prohibited). Vault Run will inform the Operator if,
in its opinion, an instruction infringes GDPR or other data-protection law.

### (b) Confidentiality
Vault Run ensures that persons authorized to process the personal data are bound
by confidentiality (contractual or statutory) and process it only as instructed.

### (c) Security of processing (Art. 32)
Vault Run implements appropriate technical and organizational measures, including:
data minimization and pseudonymization (only the pseudonymous `playerId` and
derivatives are stored — §4); an mTLS-authenticated Cloudflare + Caddy edge so the
origin is never directly reachable; bearer-locked metrics; per-socket (15 msg/s)
and (forthcoming) per-operator rate limits; signed, short-lived (120 s, single-use)
launch tokens and revocable session tokens; secrets held in a dedicated secret
manager (1Password), never in source; encrypted, off-site, client-side-encrypted
database backups with a tested restore; and an append-only significant-event audit
log. Full detail: `sla.md` §8, `data-protection-policy.md` §A (security column),
and `compliance-roadmap.md`. **Honest scope:** an internal adversarial security
audit + remediation is on record; **no third-party penetration test and no ISO/IEC
27001 certificate are held yet** (`compliance-roadmap.md` rows 8, 12).

### (d) Sub-processors
The Operator gives **general written authorization** for Vault Run to engage
sub-processors. The current sub-processors are listed in `sub-processors.md`
(infrastructure hosting, edge/CDN, error tracking, secret management, encrypted
off-site backup storage). Vault Run will:
- impose on each sub-processor, by contract, **data-protection obligations no less
  protective** than those in this DPA (Art. 28(4));
- give the Operator **prior written notice of any intended addition or replacement**
  of a sub-processor, with a reasonable period (default **[30] days**) to object on
  reasonable data-protection grounds; and
- remain **fully liable** to the Operator for a sub-processor's performance of its
  data-protection obligations.

### (e) Assist with data-subject rights
Taking account of the nature of the processing, Vault Run assists the Operator by
appropriate technical and organizational measures, **insofar as possible**, to
fulfil the Operator's obligation to respond to data-subject requests (access,
rectification, erasure, restriction, portability, objection). Because Vault Run
holds only the **pseudonymous** `playerId`, it cannot identify a data subject by
real-world identity; the Operator (as controller, the only party able to resolve
`playerId` to a person) routes a verified request to Vault Run referencing the
`playerId`, and Vault Run executes it tenant-scoped (see the erasure/anonymize flow
in `data-protection-policy.md` §C and §9 below). Retention and erasure follow the
**retention schedule and anonymize-not-delete policy** in `data-protection-policy.md`.

### (f) Assist with breach notification, DPIA and prior consultation
Vault Run:
- notifies the Operator **without undue delay** (target **[24] hours**) after
  becoming aware of a personal-data breach affecting the Operator's data, with the
  information the Operator needs for its own Art. 33/34 obligations;
- assists the Operator with security of processing (Art. 32), breach notification
  to the supervisory authority (Art. 33) and to data subjects (Art. 34), and
  data-protection impact assessments and prior consultation (Arts. 35–36), taking
  into account the nature of processing and the information available to Vault Run.

### (g) Delete or return on termination — anonymize-and-retain-ledger
At the Operator's choice, on termination of the services Vault Run **deletes or
returns** the personal data and deletes existing copies, **unless** Union or
Member-State law requires storage. In practice, Vault Run's model is
**anonymize-the-identity, retain-the-financial-record**:
- **Identity data is erased by anonymization in place** — `users.username` →
  `anon:<hash>`, `profiles.display_name` → `anon`, `game_sessions.player_id` →
  tombstone, and `users.anonymized_at` is stamped (the `anonymized_at` column
  exists in the schema for exactly this).
- **The BigInt money journal (ledger transactions and bets) and the game-round /
  fairness records are RETAINED**, de-identified, for the statutory **AML /
  bookkeeping** window (`data-protection-policy.md` §B), on the legal basis
  **GDPR Art. 17(3)(b)** (compliance with a legal obligation, e.g. anti-money-
  laundering and accounting/tax record-keeping) and **Art. 17(3)(e)** (establishment,
  exercise or defence of legal claims, e.g. dispute/chargeback handling). This is
  the controller's legal hold; the records remain available to the Operator.

The Operator may instruct return of its data in a structured export before
anonymization. Where the Operator's own jurisdiction sets a different retention
period, the **Operator's instruction governs** (these windows are Vault Run's
defaults/maximums, not a ceiling on the controller's own duties).

### (h) Make available compliance information and allow audits
Vault Run makes available to the Operator the information necessary to demonstrate
compliance with Art. 28, and allows for and contributes to **audits**, including
inspections, conducted by the Operator or a mandated auditor — subject to
reasonable notice (default **[30] days**), confidentiality, frequency limits
(default **once per 12 months** absent a breach or a regulator's request), and
not compromising other customers' data or security. Vault Run may satisfy an audit
by providing this documentation set (this DPA, `data-protection-policy.md`,
`sub-processors.md`, `sla.md`, the integration spec) and, where held, third-party
attestations (none today — see `compliance-roadmap.md`).

---

## 6. International transfers

- **Hosting region.** The production RGS and its database are hosted in the
  **EU** (production on a **Vultr** VPS; the staging and hosted sandbox on
  **Hetzner Cloud**, Falkenstein, **Germany**). See `sub-processors.md` for the
  per-sub-processor region and the exact hosting location for a given deployment.
- **Sub-processor transfers.** Two sub-processors are global by nature: the edge/CDN
  (Cloudflare) and error tracking (Sentry, only when enabled), and the encrypted
  off-site backup store (Cloudflare R2). Where these involve a transfer outside the
  EEA, it is covered by the European Commission's **Standard Contractual Clauses
  (SCCs)** and/or the relevant provider's transfer framework, with supplementary
  measures as appropriate. The exact safeguard per sub-processor is recorded in
  `sub-processors.md`.
- **Instruction.** Vault Run will not transfer the Operator's personal data to a
  third country except on the Operator's documented instruction or as required by
  law (informing the Operator first where lawful) — see §5(a).

---

## 7. Liability, term, and order of precedence

- This DPA forms part of, and is governed by, the master services / RGS agreement
  between the parties; liability, indemnities, and governing law are as set there.
- In case of conflict **on a data-protection matter**, this DPA prevails over the
  master agreement; on all other matters, the master agreement governs.
- This DPA takes effect on the later of the two signature dates and remains in force
  for as long as Vault Run processes the Operator's personal data.

---

## 8. Signatures

| Controller (Operator) | Processor (Vault Run) |
|---|---|
| Name: ________________________ | Name: ________________________ |
| Title: _______________________ | Title: _______________________ |
| Signature: ___________________ | Signature: ___________________ |
| Date: ________________________ | Date: ________________________ |

---

## 9. Annex — processing details (Art. 28(3) head + Art. 30)

This annex restates the processing for the record-of-processing requirement; the
fuller version with the security column and retention schedule is in
`data-protection-policy.md`.

**Personal data Vault Run processes (the complete list):**

- Pseudonymous `playerId` (and the derived `username` `op:{operatorId}:{playerId}:{currency}`
  and `displayName` `Player <playerId[0:6]>`);
- Session `locale`;
- Operator-scoped game/financial records (bets, rounds, cash-outs, local money
  journal) linked to the pseudonymous `playerId`, in integer minor units;
- Transient client IP — **in memory only**, as a rate-limit bucket key; never stored.

**Personal data Vault Run NEVER processes or stores:**

- Real name, email address, phone number, postal address;
- Date of birth / age;
- Government ID, KYC documents, proof of address;
- **Payment instrument — card number, bank account, crypto wallet address** (the
  seamless-wallet model means Vault Run never holds funds or sees a funding
  instrument);
- Marketing/behavioural profile, persistent geolocation, special-category (Art. 9)
  data.

**Recipients / sub-processors:** the Operator (controller) and the sub-processors
listed in `sub-processors.md`.

**Retention:** per `data-protection-policy.md` §B (anonymize identity; retain the
de-identified financial/round record for the controller's statutory hold under
Art. 17(3)(b)/(e)).
