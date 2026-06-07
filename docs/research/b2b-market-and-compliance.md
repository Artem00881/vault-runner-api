> **INTERNAL RESEARCH — inputs for Phase 6 commercial deliverables. NOT a published deliverable.** Figures here are market context with citations; final commercial terms (rev-share %, SLA tiers) are the operator's/our business decision, not a quote. Last updated 2026-06-07.

# B2B Market & Compliance Research — Vault Run (Crash RGS)

## Executive summary

For a B2B crash-game RGS like Vault Run, the market data points to a coherent path. **Revenue share**: a game supplier selling directly to operators commonly takes roughly **11–26% of GGR** for premium RNG content (lower-tier/"copy" content 9–13%, and as low as 4–7% via aggregators at volume); when a supplier distributes *through* an aggregator, the **aggregator layers on roughly 5–15% of game GGR**, with the operator's total content cost often landing around **15–35% of GGR/NGR** — but these are negotiated, scale-dependent ranges, not quotes. A directly comparable independent-RGS benchmark is **Stake Engine's published 10% GGR royalty** (developer keeps ~90%). **SLA**: igaming buyers expect cloud-grade availability (commonly **99.9%**, sometimes 99.95%/99.99% for money-critical paths), tiered support (**P1 ~15–30 min**, P2 1–2 h, P3 4–8 h, P4 1 business day) and **5–25% monthly-fee service credits** for breaches — though no single authoritative *igaming-specific* SLA template was found (numbers are general cloud/SaaS/datacenter norms). **Onboarding**: every major aggregator (SoftSwiss, Hub88, EveryMatrix/SlotMatrix, Relax Silver Bullet, Stake Engine) requires **lab certification (GLI / iTech / eCOGRA)**, a **seamless single-wallet integration**, full API integration + technical docs, and **KYB/UBO due diligence with a tier-one or recognized license**. **Certification path** (status only — we are NOT doing it now): GLI-19 governs interactive/online gaming systems incl. an **RNG chapter**, GLI-11 governs gaming devices (machine RNG), iTech Labs/BMM are accredited alternatives; for a single game/RNG expect a rough **~€25k–€40k initial, ~4–12 weeks** (secondary-source range — treat as indicative). **B2B licensing**: the supplier-license landscape centers on **MGA B2B "Critical Gaming Supply"** (€5k application, €25k–€35k annual, ~4–6 months) and **post-LOK Curaçao** (€4,592 application, €24,490 annual supervisory fee, with a B2B supplier-licensing phase-in around **Dec 2026**); Curaçao is the typical lower-barrier startup entry route, MGA the credibility upgrade. **The two biggest things to flag before writing commercial docs**: (1) all rev-share/SLA numbers are *market context*, not commitments — the deck must phrase them as ranges/our offer, not industry "facts"; and (2) the lab-cost/timeline figures are largely *secondary-source* (labs quote privately), so the compliance-roadmap status table should cite them as "indicative, vendor-quoted privately," not as fixed prices.

---

## 1. B2B revenue-share norms for online-casino game content

### Findings

**Direct supplier → operator (RNG slots / table content).** A specialist B2B aggregator/consultancy (SoftIGaming) publishes the most concrete public ranges I found, expressed as a % of **GGR**:
- **Official/premium slots:** "typically **11–26% GGR**," with top brands at the upper end and lesser-known providers lower. ([soft-igaming.com](https://soft-igaming.com/en/news/ggr/ggr.html))
- **Slot "copies" (clone content):** "around **9–13% GGR**" for a regular casino, and via an aggregator "as low as **5–7%**… for high volumes… down to **4%**." ([soft-igaming.com](https://soft-igaming.com/en/news/ggr/ggr.html))
- **Sportsbook:** "**6–10% GGR**"; **Poker:** "**10–15% GGR**." ([soft-igaming.com](https://soft-igaming.com/en/news/ggr/ggr.html))

A second source (gamblingindustryjobs.com, secondary/industry overview) gives a broader **7–20% of GGR** band for game-provider revenue share, consistent with the lower-to-mid part of the SoftIGaming range. ([gamblingindustryjobs.com](https://gamblingindustryjobs.com/features/how-gambling-companies-make-money/))

**The aggregator layer (provider → aggregator → operator).** When content is distributed through an aggregator, the aggregator adds its own cut **on top of** the studio's share:
- An aggregator's markup over direct-studio terms is commonly **5–15% of game GGR** (secondary synthesis), and one breakdown frames it as studio **15–25%**, aggregator **5–10%**, operator keeps the rest. ([track360.io](https://track360.io/glossary/casino-game-aggregator), [henkwolff.com](https://henkwolff.com/insights/best-igaming-aggregators-2026/))
- Operator's **total content cost** via an aggregator is often cited as **~15–35% of NGR/GGR** depending on aggregator, volume and negotiation leverage (secondary synthesis). ([track360.io](https://track360.io/glossary/casino-game-aggregator))
- Aggregators also frequently charge a **setup fee** plus the ongoing rev-share, and some add **content/integration fees** on top. ([casino-game-aggregator.org](https://casino-game-aggregator.org/), [track360.io](https://track360.io/glossary/casino-game-aggregator))

**Directly comparable independent-RGS benchmark (most useful for us).** Stake Engine, an RGS for independent developers, publishes an explicit commercial model: **10% GGR royalty, paid monthly, no hidden fees** — i.e. the developer **keeps ~90% of GGR** (Stake takes 10% as the RGS/distribution layer). Multiple outlets corroborate the same 10% figure and contrast it with "legacy" provider royalties of **~12–18%+** (and some report legacy platforms at 20–30%). ([stake-engine.com](https://stake-engine.com/), [next.io](https://next.io/news/b2b-news/stake-unveils-new-stake-engine-build-launch-earn-the-engine-is-yours/), [gamblinginsider.com](https://www.gamblinginsider.com/news/29242/stake-introduces-stake-engine-for-game-developers), [bitcoinchaser.com](https://bitcoinchaser.com/inside-stake-engine/))

> Note: in the Stake Engine framing the **10%** is what the *platform* takes from the *developer* — it is the RGS-distribution cut, not the studio's cut of operator GGR. Treat "supplier % of GGR" and "aggregator/platform % of GGR" as two different layers; they are not directly additive without knowing who books the GGR.

### Confidence / caveats
- **Medium confidence on the ranges, low on any single number.** The clearest figures come from one specialist source (SoftIGaming, which is itself an aggregator selling these deals, so it has an incentive to frame "via us" rates favorably). The studio/aggregator/operator split numbers are **secondary synthesis** (glossary/blog sources), not provider contracts — mark as *indicative*.
- The **Stake Engine 10%** is the best-sourced, most directly comparable figure (it is Stake's own published model, corroborated by ≥3 outlets) — but it reflects Stake's aggressive positioning for indie devs, not a universal norm.
- Real deals vary by **brand strength, exclusivity, volume/MG (minimum guarantees), market (regulated vs grey), and whether crypto**. Crash/instant-win specifically: **no crash-specific public rev-share %** was found — slots ranges are the closest proxy.

### Implications for Vault Run
- Frame our rev-share in the deck as a **range we offer** (e.g. anchored to the slots band and the Stake Engine 10% comparable), **not** as "the industry rate."
- Decide our distribution posture: **direct-to-operator** (capture the full supplier %, but we carry integration + KYB load) vs **via an aggregator** (faster reach, but give up the aggregator's 5–15% layer). The deck/rev-share doc should present both.
- As a single-game crash RGS we are closest to the **Stake-Engine-style RGS layer** model — a flat GGR royalty is a defensible, simple structure to pitch.

---

## 2. SLA norms for game-content / RGS providers

### Findings

No single **igaming-specific** authoritative SLA template surfaced; the numbers below are the **general cloud/SaaS/datacenter norms** that igaming buyers apply, and they are consistent across the sources checked.

**Uptime / availability.**
- **99.9%** ("three nines") is the most common business-critical target ≈ **8.7–8.8 hours/year** downtime (~43 min/month). ([databank.com](https://www.databank.com/resources/blogs/the-critical-role-of-service-level-agreements-slas-in-ensuring-data-center-reliability/), [web-alert.io](https://web-alert.io/blog/uptime-sla-explained-99-9-vs-99-99-availability))
- **99.99%** ("four nines") ≈ **52.6 min/year** (~4.4 min/month), used for **payment/auth/core infrastructure** — i.e. the money path. ([web-alert.io](https://web-alert.io/blog/uptime-sla-explained-99-9-vs-99-99-availability))
- **99.999%** ("five nines") ≈ **5.26 min/year** — rarely contractually promised at the application layer. ([databank.com](https://www.databank.com/resources/blogs/the-critical-role-of-service-level-agreements-slas-in-ensuring-data-center-reliability/), [fiberfed.com](https://fiberfed.com/understanding-sla-uptime/))

**Support-response tiers (industry benchmark).** P1 critical **15–30 min**; P2 high **1–2 h**; P3 medium **4–8 h**; P4 low **1 business day**. ([emailmeter.com](https://www.emailmeter.com/blog/sla-response-time))

**Latency / performance.** Strong SLAs cover **network latency, throughput and processing-speed** benchmarks, not just uptime; real-time/streaming SLAs explicitly define and measure latency guarantees. ([databank.com](https://www.databank.com/resources/blogs/the-critical-role-of-service-level-agreements-slas-in-ensuring-data-center-reliability/), [conduktor.io](https://www.conduktor.io/glossary/sla-for-streaming)) (No public *crash-game tick-latency* SLA number was found — this is a value we set from our own load-test data.)

**Service credits / penalties.** Breaches are typically remedied via **service credits of ~5–25% of the monthly fee**, scaled to how far below target uptime fell (e.g. 99→10% credit; 95–99%→up to 25%). Sources note credits "almost never cover the lost revenue" from a real outage — credits are the standard remedy, not full damages. ([derrick-app.com](https://derrick-app.com/en/sla-uptime-guarantees-2/), [siliceum.com](https://www.siliceum.com/en/blog/post/sla-engagements/))

**Planned maintenance** is normally **excluded from the uptime calculation** when announced within an agreed notice window — a standard SLA carve-out (general SaaS practice). ([web-alert.io](https://web-alert.io/blog/uptime-sla-explained-99-9-vs-99-99-availability))

### Confidence / caveats
- **High confidence the numbers above are the prevailing cloud/SaaS norms; LOW confidence they are specifically "igaming RGS standard."** Repeated targeted searches for *igaming/RGS* SLA contract language returned only generic SLA references — **no aggregator/operator published its own RGS SLA terms** in what I could access. Treat these as **the benchmarks our buyers will expect**, not as a citation that "RGS providers guarantee X."
- Specific **latency** and **maintenance-window** figures for crash/real-time game servers are **unverified from public sources** — we should set them from our own metrics (we already track settlement p99 and have load-test data).

### Implications for Vault Run
- Propose **99.9% uptime** as the headline (achievable, common), and consider **99.95%** as a premium tier; reserve **99.99%** language only for the money/settlement path if our HA design supports it.
- Adopt the **P1–P4 tiering** and **5–25% service-credit ladder** verbatim as a starting SLA draft — it matches buyer expectations and is easy to defend.
- Define a **real-time latency commitment** (e.g. settlement/cash-out p99) from our load tests rather than copying a generic number; carve out **announced planned maintenance**.

---

## 3. Aggregator / operator onboarding requirements (new game supplier)

### Findings — common pattern across platforms

Across every major aggregator checked, a **new game supplier** must clear four gates: **(a) lab certification, (b) a seamless single-wallet technical integration + full API docs, (c) KYB/UBO due diligence, and (d) a recognized/tier-one license.**

**SoftSwiss Game Aggregator.**
- Integration is via the **Game Aggregator casino games API**; a single integration replaces dozens of direct studio connections (seamless/single-integration model). ([softswiss.com](https://www.softswiss.com/game-aggregator/))
- New game-provider onboarding includes **security and technical audits**: the aggregator undergoes a security audit by **accredited testing companies**, and **each provider's technical integration is individually tested**. ([softswiss.com](https://www.softswiss.com/game-aggregator/))

**Hub88 (aggregator; runs both Operator and Supplier APIs).**
- "**Every game on Hub88 is certified by recognized testing labs, including eCOGRA, GLI, and iTech Labs**," and "**all providers hold licenses from reputable jurisdictions**"; Hub88 states it partners with providers licensed by **MGA, UKGC, Curaçao eGaming** and other tier-one regulators. ([hub88.io](https://hub88.io/casino-game-suppliers))
- Suppliers connect through the **Supplier API** with full developer docs; onboarding starts with an in-depth consultation, then API access. ([hub88.io](https://hub88.io/casino-api-integration), [docs.hub88.io](https://docs.hub88.io/developer-docs)) Direct studio integration "the traditional manner" is cited as **3–6 months** of dev/test/cert vs days via the aggregator. ([thecoastnews.com](https://thecoastnews.com/fast-track-integration-how-hub88s-simple-api-is-empowering-operators-and-suppliers-in-2025/))

**EveryMatrix / SlotMatrix (RGS + aggregator).**
- Pure B2B aggregator; **SlotMatrix RGS powers slots, table games, instant wins** and explicitly lists **crash** among the content types; **certified in multiple markets (Europe, US, LATAM)**. ([everymatrix.com](https://everymatrix.com/slotmatrix/), [everymatrix.com/slotmatrix/rgs](https://everymatrix.com/slotmatrix/rgs/))
- Operates a formal **partner onboarding process for game studios** (press releases document studios being "onboarded to SlotMatrix RGS"); detailed integration docs are behind a partner/developer portal (not public). ([everymatrix.com](https://everymatrix.com/everymatrix-onboards-spinberry-to-slotmatrix-rgs/))

**Relax Gaming "Silver Bullet."**
- Distribution program for **vetted independent studios** through Relax's **250+ operator network**; partners keep their brand. ([relax-gaming.com/partners/silverbullet](https://www.relax-gaming.com/partners/silverbullet))
- Notably, Relax positions Silver Bullet as covering **compliance/certification overhead**: "Relax Gaming's regulatory framework **covers Silver Bullet studios' certifications**, removing the overhead of independent licensing processes." (secondary review summary — verify exact scope directly with Relax). ([relax-gaming.com/news](https://www.relax-gaming.com/news/2025/07/relax-gaming-reaffirms-support-for-growing-suppliers-via-its-silver-bullet-platform), [gamingsoft.com](https://www.gamingsoft.com/blog/2026/05/relax-gaming-slots-provider/))

**Stake Engine (RGS for independent devs).**
- **Build/Launch/Earn** self-serve RGS: developers publish via a **Math SDK** (Python) and must follow a **strict required math-file format** — "these are strict conditions for successful math file publication." Games are hosted at a **standardized RGS URL** with auth/bet/round-completion endpoints; devs can test **inside the Stake Engine RGS environment** (no separate staging). ([stakeengine.github.io/RGS](https://stakeengine.github.io/math-sdk/rgs_docs/RGS/), [stakeengine.github.io/data_format](https://stakeengine.github.io/math-sdk/rgs_docs/data_format/), [stake-engine.com](https://stake-engine.com/))
- Explicitly supports **crash / provably-fair mechanics** as a target use case. ([stake.com/blog](https://stake.com/blog/what-is-stake-engine))

**KYB / due-diligence (general standard the above all apply).** KYB onboarding establishes the **UBO(s)** and typically requires **company registration/incorporation docs, ownership-structure details, UBO identification + government ID, licensing status, and adverse-media screening**; depth scales with the entity's risk profile. ([idenfy.com](https://idenfy.com/blog/know-your-business-kyb/), [moodys.com](https://www.moodys.com/web/en/us/kyc/resources/insights/what-is-kyb-know-your-business-understand-risk-and-establish-trust.html))

### Confidence / caveats
- **High confidence on the *pattern*** (cert + seamless single-wallet API + KYB + license) — it is stated explicitly by Hub88 and SoftSwiss and is consistent across all platforms.
- **Lower confidence on platform-specific *technical* requirements**: EveryMatrix and Stake's detailed integration specs are **behind partner/developer portals**, not fully public; Hub88's docs site is public but I summarized it rather than reading every endpoint. The Relax "covers your certification" claim is from a **secondary review** — confirm exact scope with Relax before relying on it commercially.
- Several platforms state partners must hold a **tier-one license** (MGA/UKGC/Curaçao) — this directly couples onboarding to Section 5 (our supplier-license question).

### Implications for Vault Run
- Our **Phase 6 trust-package already maps to the gates**: API integration spec + Postman + hosted seamless-wallet sandbox (technical integration), provably-fair guide + math spec + sim report (cert-readiness evidence). The missing pieces are **the actual lab cert** and **a recognized license** — both are *roadmap status*, not built.
- A pragmatic launch route is **via an aggregator** (e.g. EveryMatrix/SlotMatrix explicitly carry crash; Relax Silver Bullet / Hub88) — several **provide compliance/cert cover or a single cert umbrella**, lowering our barrier; the trade-off is the aggregator rev-share layer (Section 1).
- Prepare a **KYB pack** (incorporation docs, UBO chart + IDs, license status, AML policy) as a standard onboarding deliverable — it will be requested by every counterparty.

---

## 4. RNG / game certification path (STATUS table only — we are NOT certifying now)

### Findings

**GLI-19 — Interactive Gaming Systems (online).** This is the standard for **server-based/online gaming systems "where game logic runs on centralized servers"** — i.e. an RGS like ours. Its four chapters are: **Introduction; Platform/System Requirements; Random Number Generator (RNG) Requirements; Game Requirements**, and it is explicitly "intended to be used by regulatory bodies, operators and industry suppliers as a compliance guideline" (jurisdictions adopt/adapt it). ([GLI-19 v3.0 PDF](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf), [techmast.org](https://techmast.org/technical-gaming-standards-guide/))
- Core areas it evaluates include **game functionality, financial transactions, player-account management, security, administrative controls, RNG algorithms, communications, and audit trails**. ([techmast.org](https://techmast.org/technical-gaming-standards-guide/))

**GLI-11 — Gaming Devices (machines).** Standard for **gaming device/machine requirements**; includes a **Chapter 3 RNG Requirements** (General RNG, Software-Based RNG, Hardware-Based RNG, Mechanical/Physical RNG). It deliberately **does not mandate a specific algorithm** — any method that meets the criteria conforms — and requires the RNG/selection process to be **"impervious to influences from outside the device."** ([GLI-11 v3.0 PDF](https://gaminglabs.com/wp-content/uploads/2018/09/GLI-11-Gaming-Devices-V3-0.pdf), search synthesis)
- **GLI-19 vs GLI-11 distinction:** GLI-19 = **online/interactive systems** (the right primary standard for a remote crash RGS); GLI-11 = **physical/EGM gaming devices** (machine RNG). A crash RGS is squarely a GLI-19 case, though the **RNG sub-requirements are conceptually shared** and labs often cite both. ([techmast.org](https://techmast.org/technical-gaming-standards-guide/))

**What an RNG test actually involves (GLI).** GLI's RNG service lists: **source-code review; assessment of the RNG period; determination of the RNG range; investigation of seeding/re-seeding; inspection of background cycling/activity; the DIEHARD battery of tests; and outcome-distribution tests** — to confirm **non-predictability and no bias toward outcomes**. ([gaminglabs.com RNG service](https://gaminglabs.com/services/igaming/random-number-generator-rng/))
- **Submission artifacts (GLI):** the **application used to generate the random data "as close to the final production application as possible,"** an **explanation of any differences** between test and production data generation, an **RNG Final Outcome Collection Tool**, and (if in scope) a **Raw Output Collection Tool** to capture output **before scaling/shuffling**. ([gaminglabs.com — RNG technical specs](https://gaminglabs.com/getting-started/technical-specifications-for-rng-testing/))

**iTech Labs.** Accredited lab; **RNG testing = source-code evaluation → compile to generate raw RNG output → test the raw numbers AND the scaled/shuffled output**; the supplier submits source code and states whether the RNG is **PRNG or hardware-based**. iTech applies **the standards of the target jurisdiction "supplemented with risk-based tests."** Process is a 5-stage flow (reach out → define scope/timeline → approve fixed-price quote → testing with **weekly/bi-weekly progress reports** → certificate issued for regulatory submission); certificates issue after **first-pass testing + retest of defects, once high/medium issues are resolved.** ([itechlabs.com RNG](https://itechlabs.com/compliance-testing/rng-testing/), [itechlabs.com FAQ](https://itechlabs.com/faqs/))
- For **crash games specifically** (secondary description): auditors examine the **crash algorithm's source code**, verify the seed isn't predictably seeded and the multiplier generation is **cryptographically sound**, and **run millions of simulated rounds** to confirm crash points distribute naturally and don't cluster. ([leerebelwriters.com](https://www.leerebelwriters.com/how-crash-game-testing-works-a-complete-guide-for-5/) — secondary)

**BMM Testlabs.** The third major accredited lab; BMM-01 is its standard (originating in slot-machine logic, also applied to online platforms e.g. New Jersey). Treated as an **alternative to GLI/iTech** for the same regulated markets. ([techmast.org](https://techmast.org/technical-gaming-standards-guide/)) (I did not find a BMM primary page detailing crash-specific testing — **gap**.)

**Timeline & cost (indicative; mostly secondary).**
- **Initial RNG/GLI-19 or iTech certification: ~€25,000–€40,000**; **annual re-testing ~€8,000–€15,000** (secondary, RNG-cert consultancies). A separate US-framed source gives **$10k–$50k per game/platform** initial and **$5k–$25k** for annual recert/audits. ([key2law.com](https://key2law.com/en/licences/rng-certification/rng-certification), search synthesis)
- **Timeline: ~4–12 weeks** typical; **2–3 weeks** if docs are fully compliant on submission, stretching to **1.5–2 months** for startups when RNG issues surface. A platform-level multi-game certification is cited at **8–12 weeks initial + 2–4 week remediation cycles, ~4–6 months total, ~$75k–$150k** (that figure is for a **full multi-game platform**, not a single RNG). ([key2law.com](https://key2law.com/en/licences/rng-certification/rng-certification), [techmast.org](https://techmast.org/technical-gaming-standards-guide/))
- **RNG analysis effort inside a GLI engagement** is described as **10–15 days of continuous testing generating "billions of game outcomes"** (secondary). ([techmast.org](https://techmast.org/technical-gaming-standards-guide/))

**Pre-certification readiness review.** This is a **paid pre-engagement** where the lab/consultant reviews your math spec, RNG implementation/source, simulation evidence and docs **against the target standard before formal submission**, to surface defects early (cheaper than failing first-pass). It maps directly to what iTech calls "**define scope/requirements**" and to fixing **high/medium issues before the certificate issues**. ([itechlabs.com FAQ](https://itechlabs.com/faqs/)) (No fixed public price — labs quote privately.)

### Confidence / caveats
- **GLI-19/GLI-11 scope and the RNG test battery = high confidence** (GLI's own pages + the standards PDFs; cross-checked with a technical-standards reference). I could **not parse the GLI-19 PDF body locally** (binary; no `poppler` to render, and WebFetch couldn't extract it) — so chapter/area detail is corroborated via **GLI's own RNG page + a secondary technical guide**, not quoted from the PDF text. Treat exact clause numbers as **unverified to the source line**.
- **All cost/timeline numbers are largely SECONDARY** (cert consultancies/blogs). Labs (GLI, iTech, BMM) **do not publish prices**; they quote per project. Use the ranges as **"indicative, vendor-quoted privately"** in the status table — **do not present any single figure as authoritative.** The **€25–40k / 4–12 weeks** band is the most repeated for a single game/RNG; the **$75–150k / 4–6 months** is for a **full multi-game platform** and should not be applied to our one crash game.
- The **crash-specific iTech description** ("millions of rounds, no clustering") is **secondary** — directionally correct and consistent with how RNG distribution testing works, but not an iTech primary statement.
- **BMM crash-specific detail = gap/unverified.**

### Implications for Vault Run
- **GLI-19 is our primary target standard** (interactive/online system + RNG chapter), with **iTech Labs a strong, often lower-friction alternative** for a single crash RNG; BMM is a third option. The status table should name **GLI-19 (system+RNG) / iTech (RNG)** as the realistic route.
- **Our existing artifacts map well to a readiness review:** the **game math spec**, the **1e9-round simulation report** (run through the *exact production* `computeCrash`), and the **provably-fair guide** (SHA-256 seed chain + ETH-block-hash salt) cover most of what a lab asks for upfront — source code + math description + outcome-distribution evidence + seeding/reseeding explanation. **Gaps vs a real submission:** a near-production **RNG Final Outcome / Raw Output collection tool** in the lab's required format, jurisdiction selection, and the formal source-code escrow/access the lab needs.
- Phrase the roadmap as **"cert-ready, not yet certified"**: we can credibly describe the path, the standard, and indicative cost/time, and show our evidence package — without claiming a certificate we don't hold.

---

## 5. B2B SUPPLIER licensing landscape (high level; STATUS only)

### Findings

A **B2B game supplier** (not the operator) generally needs a **supplier/"critical gaming supply" authorization** to sell into regulated markets — distinct from a B2C operator license.

**MGA — B2B "Critical Gaming Supply" (Malta).** The recognized, credible supplier license. Per MGA's own page:
- **Application fee: €5,000** (one-time, non-refundable). ([mga.org.mt](https://www.mga.org.mt/licensee-hub/applications/b2b-licences/game-providers-and-back-office/))
- **Annual licence fee** scales by activity/revenue: **€10,000** (Type 4 only), **€25,000** (revenue ≤€5M), **€30,000** (€5M–€10M), **€35,000** (>€10M). ([mga.org.mt](https://www.mga.org.mt/licensee-hub/applications/b2b-licences/game-providers-and-back-office/))
- Covers supply of **core game elements / software / control systems**; gaming Types 1–4 (Type 1 = casino incl. RNG games). ([mga.org.mt](https://www.mga.org.mt/licensee-hub/applications/b2b-licences/game-providers-and-back-office/))
- Secondary sources add: **minimum share capital ~€40,000** (B2B), **~4–6 month** process, **10-year** validity, plus a **compliance contribution** and required **key persons (compliance/AML, ≥1 director)** — verify exact capital/contribution against the MGA's current System Documentation Checklist. ([network-42.com](https://network-42.com/complete-guide-mga-license-types/), [legarithm.io](https://legarithm.io/license/b2b/malta/) — secondary)

**Curaçao — post-LOK (National Ordinance on Games of Chance).** Historically the **low-barrier startup route**; reformed under **LOK, effective 24 Dec 2024**, which **abolished the master/sub-license model** and made **direct CGA licensing mandatory** for B2C and for **B2B gaming suppliers** (game-software developers, RNG-engine providers, platform suppliers, etc.). ([agbrief.com](https://agbrief.com/news/world/03/11/2025/curacao-gaming-authority-updates-fee-policy-under-new-lok-framework/), [coincub.com](https://coincub.com/blog/curacao-gaming-license/))
- **Application fee: €4,592** (~$5,340); **annual supervisory fee for B2B suppliers: €24,490** (~$28,470). ([agbrief.com](https://agbrief.com/news/world/03/11/2025/curacao-gaming-authority-updates-fee-policy-under-new-lok-framework/))
- **B2B supplier licensing phases in ~2 years after Dec 2024 → ~Dec 2026**; B2B **cannot be combined with B2C** without specific CGA approval. ([coincub.com](https://coincub.com/blog/curacao-gaming-license/) — secondary)
- New **substance requirements**: Curaçao-registered company + local office, **≥1 Curaçao-resident director** (or local managing entity), local employee, and a **dedicated compliance officer**. ([agbrief.com](https://agbrief.com/news/world/03/11/2025/curacao-gaming-authority-updates-fee-policy-under-new-lok-framework/), [coincub.com](https://coincub.com/blog/curacao-gaming-license/))

**Other jurisdictions (high level).** UKGC, Isle of Man, and several EU markets (Romania, etc.) license/recognize B2B suppliers but at **higher cost/scrutiny** (UKGC especially) — these are **credibility/market-access upgrades**, not startup entry points. (General industry knowledge; not separately sourced here — **mark as background, verify before relying on**.)

**ISO/IEC 27001 (information-security standard — not a gambling license, but expected of suppliers).** Increasingly a **de-facto requirement** for B2B suppliers: some jurisdictions **require** accredited ISO 27001 of licensees/service providers (e.g. **Bulgaria, Greece, Switzerland**), and others (**Colombia, Denmark, Great Britain, Portugal, Romania, Spain, Sweden**) **waive parts of their security-audit requirement** if you hold it. A credible ISO 27001 certificate **expedites lab testing and operator due diligence** (auditors trust a known benchmark over self-assertion). Leading studios (e.g. Push Gaming) hold it. ([isms.online](https://www.isms.online/sectors/iso-27001-for-the-gaming-industry/), [gamingassociates.com](https://gamingassociates.com/iso-iec-27001-certification/), [ecogra.org](https://ecogra.org/igaming/security-assessments-and-the-benefits-of-iso-27001/), [igamingfuture.com](https://igamingfuture.com/push-gaming-achieves-iso27001-certification-for-information-security-management/))

### Confidence / caveats
- **MGA fees and Curaçao fees = high confidence** (MGA's own page; AGB reporting CGA's fee policy). **MGA share capital (~€40k) and the compliance contribution = secondary/medium** — confirm against MGA's current checklist before quoting.
- **Curaçao B2B phase-in date (~Dec 2026) is secondary** and the reform is **still bedding in** — treat the timeline as provisional and re-check closer to any decision.
- **Which route is "lowest barrier" is shifting:** Curaçao was historically cheapest/fastest, but **post-LOK substance + the dedicated B2B supplier license raise the bar**; it is still generally **lower-barrier than MGA**, but the gap has narrowed. Mark this as **a moving target**.
- **"Do we even need a supplier license yet?"** — depends entirely on **which markets/operators we sell to**. Selling to **MGA/UKGC operators** effectively requires a recognized supplier license; selling to **Curaçao-licensed operators** ties to the LOK phase-in. This is a **business/legal decision**, not a settled fact — flag for counsel.

### Implications for Vault Run
- **Status-table framing:** present **Curaçao (post-LOK)** as the likely **entry-level supplier route** (~€4.6k application + ~€24.5k/yr) and **MGA B2B Critical Gaming Supply** as the **credibility/market-access upgrade** (~€5k application + €25–35k/yr, ~4–6 months, ~€40k capital) — both as **roadmap, not in progress**.
- **ISO 27001 is the highest-leverage near-term credibility item** that is *not* a gambling license: it's expected by operators/labs, **speeds up everything downstream**, and is something we could pursue independently of any gambling regulator. Worth calling out separately in the compliance-roadmap.
- The **license requirement is coupled to onboarding** (Section 3: aggregators require a tier-one/recognized license) — so "which license" is partly dictated by **which aggregator/operator we target first**.

---

## What remains UNVERIFIED / single-source (flag before publishing)

- **All rev-share %** are market context, not quotes; the cleanest figures come from **one specialist source (SoftIGaming)** with a selling incentive. **No crash-specific public rev-share** found — slots band used as proxy. The **Stake Engine 10% GGR** is the best-sourced comparable.
- **No igaming-specific SLA template** was found in public sources — uptime/response/credit numbers are **general cloud/SaaS/datacenter norms** our buyers apply; **crash-game latency and maintenance-window** figures must come from **our own metrics**, not a citation.
- **GLI-19 PDF body could not be parsed locally** (binary; no PDF renderer; WebFetch extraction failed) — chapter/RNG detail is corroborated via **GLI's own RNG pages + a secondary technical guide**, so **exact clause numbers are unverified to the source line**.
- **Cert cost/timeline figures are largely SECONDARY** (consultancies/blogs); labs quote privately. The **€25–40k / 4–12 weeks** single-game band and the **$75–150k / 4–6 months** *multi-game platform* figure are indicative — **do not present as authoritative**, and don't apply the platform figure to our single game.
- **BMM Testlabs crash-specific testing detail = gap** (no primary page read).
- **Platform-specific technical integration specs** for EveryMatrix and Stake Engine are **behind partner/developer portals**; the **Relax Silver Bullet "covers your certification" claim is secondary** — confirm scope directly with each platform.
- **MGA share-capital (~€40k) + compliance contribution** and the **Curaçao B2B phase-in (~Dec 2026)** are **secondary/medium confidence** — verify against the regulators' current official docs before any decision.
- **UKGC / Isle of Man / Romania** supplier-licensing specifics are **background only**, not separately sourced here.

---

## Sources

**Revenue share**
- https://soft-igaming.com/en/news/ggr/ggr.html (provider/aggregator GGR ranges — specialist, selling incentive)
- https://gamblingindustryjobs.com/features/how-gambling-companies-make-money/ (7–20% GGR band — secondary)
- https://track360.io/glossary/casino-game-aggregator (aggregator layer / total cost — secondary)
- https://henkwolff.com/insights/best-igaming-aggregators-2026/ (studio/aggregator/operator split — secondary)
- https://casino-game-aggregator.org/ (setup fee + rev-share — secondary)
- https://stake-engine.com/ (Stake Engine 10% GGR royalty — primary)
- https://next.io/news/b2b-news/stake-unveils-new-stake-engine-build-launch-earn-the-engine-is-yours/ (corroborates 10% — secondary)
- https://www.gamblinginsider.com/news/29242/stake-introduces-stake-engine-for-game-developers (corroborates 10% — secondary)
- https://bitcoinchaser.com/inside-stake-engine/ (legacy 12–18%+ comparison — secondary)

**SLA**
- https://www.databank.com/resources/blogs/the-critical-role-of-service-level-agreements-slas-in-ensuring-data-center-reliability/ (uptime tiers, latency)
- https://web-alert.io/blog/uptime-sla-explained-99-9-vs-99-99-availability (99.9 vs 99.99 downtime math; maintenance carve-out)
- https://fiberfed.com/understanding-sla-uptime/ (five-nines)
- https://www.emailmeter.com/blog/sla-response-time (P1–P4 response benchmarks)
- https://www.conduktor.io/glossary/sla-for-streaming (real-time/latency SLAs)
- https://derrick-app.com/en/sla-uptime-guarantees-2/ (service-credit ladder)
- https://www.siliceum.com/en/blog/post/sla-engagements/ (credits don't cover lost revenue)

**Aggregator / operator onboarding**
- https://www.softswiss.com/game-aggregator/ (single-API model; provider security/technical audit)
- https://hub88.io/casino-game-suppliers (cert by GLI/iTech/eCOGRA; tier-one license requirement)
- https://hub88.io/casino-api-integration ; https://docs.hub88.io/developer-docs (Supplier API / docs)
- https://thecoastnews.com/fast-track-integration-how-hub88s-simple-api-is-empowering-operators-and-suppliers-in-2025/ (3–6 month direct-integration baseline — secondary)
- https://everymatrix.com/slotmatrix/ ; https://everymatrix.com/slotmatrix/rgs/ (SlotMatrix RGS incl. crash; certified markets)
- https://everymatrix.com/everymatrix-onboards-spinberry-to-slotmatrix-rgs/ (studio onboarding process)
- https://www.relax-gaming.com/partners/silverbullet ; https://www.relax-gaming.com/news/2025/07/relax-gaming-reaffirms-support-for-growing-suppliers-via-its-silver-bullet-platform (Silver Bullet; cert cover claim)
- https://www.gamingsoft.com/blog/2026/05/relax-gaming-slots-provider/ (Silver Bullet "covers certifications" — secondary)
- https://stakeengine.github.io/math-sdk/rgs_docs/RGS/ ; https://stakeengine.github.io/math-sdk/rgs_docs/data_format/ (Stake Engine math-file/RGS integration)
- https://idenfy.com/blog/know-your-business-kyb/ ; https://www.moodys.com/web/en/us/kyc/resources/insights/what-is-kyb-know-your-business-understand-risk-and-establish-trust.html (KYB/UBO requirements)

**RNG / game certification**
- https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf (GLI-19 standard — PDF not parsed locally)
- https://gaminglabs.com/wp-content/uploads/2018/09/GLI-11-Gaming-Devices-V3-0.pdf (GLI-11 standard)
- https://gaminglabs.com/services/igaming/random-number-generator-rng/ (GLI RNG test battery — primary)
- https://gaminglabs.com/getting-started/technical-specifications-for-rng-testing/ (GLI RNG submission artifacts — primary)
- https://techmast.org/technical-gaming-standards-guide/ (GLI-19/GLI-11/BMM scope, test-case/cost/time — secondary)
- https://itechlabs.com/compliance-testing/rng-testing/ (iTech RNG testing — primary)
- https://itechlabs.com/faqs/ (iTech process/quote model — primary)
- https://www.leerebelwriters.com/how-crash-game-testing-works-a-complete-guide-for-5/ (crash-specific testing description — secondary)
- https://key2law.com/en/licences/rng-certification/rng-certification (RNG cert cost/timeline ranges — secondary)

**B2B supplier licensing + ISO 27001**
- https://www.mga.org.mt/licensee-hub/applications/b2b-licences/game-providers-and-back-office/ (MGA B2B fees/types — primary)
- https://network-42.com/complete-guide-mga-license-types/ (MGA capital/timeline — secondary)
- https://legarithm.io/license/b2b/malta/ (MGA B2B summary — secondary)
- https://agbrief.com/news/world/03/11/2025/curacao-gaming-authority-updates-fee-policy-under-new-lok-framework/ (Curaçao LOK fees — secondary/news)
- https://coincub.com/blog/curacao-gaming-license/ (LOK B2B scope/phase-in/substance — secondary)
- https://www.isms.online/sectors/iso-27001-for-the-gaming-industry/ (ISO 27001 jurisdiction requirements)
- https://gamingassociates.com/iso-iec-27001-certification/ (ISO 27001 for iGaming)
- https://ecogra.org/igaming/security-assessments-and-the-benefits-of-iso-27001/ (ISO 27001 speeds testing)
- https://igamingfuture.com/push-gaming-achieves-iso27001-certification-for-information-security-management/ (studio holding ISO 27001)
