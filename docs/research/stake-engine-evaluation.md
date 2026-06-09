> **INTERNAL RESEARCH — strategic input for a "build-on-our-own-RGS vs publish-via-Stake-Engine" decision. NOT a published deliverable.** Every load-bearing claim is cited; items I could NOT verify from a primary source are explicitly FLAGGED. The official `stake-engine.com/docs/*` pages are JS-rendered and would not fetch as text, so I sourced from the GitHub docs (`stakeengine.github.io/math-sdk/…`), the `StakeEngine/*` GitHub repos, and corroborating industry coverage. Last updated 2026-06-09.

# Stake Engine — Evaluation for Vault Run (own crash RGS + 3D frontend)

## Executive summary / verdict

**Does Stake Engine remove the certification headache for a fast start? Largely YES — but only because Stake Engine sells into Stake's own Curaçao/Anjouan‑tier ecosystem, which by design carries "no Tier‑1 compliance overhead." It does not give us a portable cert or a license; it lets us ride Stake's.** The trade-offs are real and specific to us.

What it removes: a developer publishing on Stake Engine does **not** need their own gambling license and does **not** need their own GLI/iTech accredited‑lab RNG certificate to go live on Stake.com. The game runs under **Stake's** Curaçao master license (Medium Rare N.V., OGL/2024/1451/0918) + Anjouan, and the "~24h approval" is **Stake's internal QA/math‑format validation, not an accredited external lab certification** (best‑sourced inference — see §1 caveats). Commercial terms are genuinely attractive and well‑sourced: **10% of GGR, monthly, no hidden fees, developer keeps IP, "no exclusivity, no lockups."**

What it does NOT remove / the trade-offs **specific to us**:
1. **Game‑type fit is the biggest risk.** The Math SDK is built around **pre‑simulated, discrete outcome "books"** (CSV lookup tables of `simulation_id, probability, integer payout_multiplier`) that **Stake's RGS** samples at runtime. Every shipped example is a slot variant. This is a **fundamentally different model from our live crash engine** (a continuous multiplier rising in real time, with a mid‑round player cash‑out decision and our own eth‑block‑salted provably‑fair RNG). Whether a real‑time, player‑interactive crash maps cleanly onto Stake Engine's book model is **NOT something I could confirm from the docs — FLAG as the #1 open question** (§3).
2. **Our provably‑fair layer becomes redundant/unused.** On Stake Engine the RNG and fairness are **Stake's** (Stake Originals Crash uses Stake's own server/client seed + hash chain). Our eth‑block salt oracle and SHA‑256 seed chain — a core differentiator — would not be the system of record.
3. **Our 3D frontend is mostly portable — this is the good news.** The PixiJS/Svelte frontend SDK is **explicitly optional**: "you can use anything as long as it compiles to a static website." A three.js/WebGL build that compiles to static files and calls the RGS REST endpoints is allowed (§4). But the game *logic/outcomes* must be expressed as Stake's math books, so the frontend would become a **renderer of Stake‑RGS‑decided outcomes**, not the driver — a meaningful re‑architecture of how our client and server interact.
4. **Distribution is effectively Stake‑only.** Contractually non‑exclusive, but in practice Engine games are "available with crypto only on Stake.com," the build is wired to Stake's RGS/CDN, and there is **no built‑in channel to other operators**. This **directly conflicts with our white‑label B2B ambition** — Stake Engine is a *distribution endpoint*, not a substitute for our own RGS that we sell to many operators (§2).
5. **Addressable market is the Stake ecosystem only** (Curaçao/Anjouan + Stake's local BR/CO/MX/PE/DK licenses). It explicitly does **NOT** reach MGA/UKGC/ADM(Italy)/GGL(Germany) regulated markets (§6) — the same ceiling our own Curaçao‑tier path has, but here we're a tenant rather than the supplier.

**Bottom line for the decision:** Stake Engine is a credible *complementary "for the start" distribution play* — a way to get a game in front of ~Stake's player base fast, with zero license/cert spend, while keeping our IP and the right to sell elsewhere. It is **not** a replacement for the RGS we built, and it does not advance our B2B/white‑label or regulated‑market goals; it sidesteps them. The honest framing: **publishing on Stake Engine ≈ "becoming a Stake content studio," whereas our own RGS ≈ "becoming a B2B supplier."** Those are different businesses. The crash‑specific math‑model fit (§3) must be validated hands‑on before treating Stake Engine as a viable home for *our* crash game.

---

## 1. Certification / compliance model (the core question)

### Findings
- **No own license, no own accredited RNG cert to publish on Stake.** Multiple outlets describe Stake Engine as a "no‑gatekeeper," self‑serve route where independent devs publish directly to Stake.com; SDK access is **now open to anyone** (it was previously invite‑only/waitlist on engine.stake.com). ([igamingfuture.com](https://igamingfuture.com/stake-launches-stake-engine-to-expand-developer-access/) — via search summary, page 403'd; [igamingchronicle.com](https://igamingchronicle.com/stake-launches-stake-engine-to-reward-independant-game-developper/); Stake Forum "Stake Engine is now open to everyone" [stakecommunity.com](https://stakecommunity.com/topic/149516-stake-engine-is-now-open-to-everyone-is-this-a-strategic-and-benefic/))
- **The "~24h approval" is internal QA / math‑format validation, not an external lab cert.** The Math SDK docs state Stake "will carry out **preliminary checks to ensure game‑logic is of the expected format**, and the corresponding payout multipliers and probabilities are analyzed as a means of providing a quick summary of game statistics on the backend." ([stakeengine.github.io/data_format](https://stakeengine.github.io/math-sdk/rgs_docs/data_format/)) Coverage describes "instant game testing and instant deployment," "approval… within 24 hours," "usually a day or two." ([betensured.com](https://www.betensured.com/blog/stake-engine-what-it-is-and-how-it-works/); search summary of [stake.com/blog](https://stake.com/blog/what-is-stake-engine), page 403'd) — **This is consistent with an internal review, not a GLI/iTech engagement (which run weeks and issue a certificate). I did NOT find a primary statement that Stake performs, or skips, accredited‑lab testing — see caveats.**
- **Why this is possible: Stake's licensing tier doesn't demand per‑game lab testing.** Stake.com runs on a **Curaçao GCB master license (Medium Rare N.V., OGL/2024/1451/0918) + Anjouan**, chosen for "maximum geographic coverage **without Tier‑1 compliance overhead**." ([track360.io operator review](https://track360.io/blog/stake-com-operator-review-2026-crypto-casino-analysis); [worldpokerdeals.com](https://worldpokerdeals.com/blog/stake-countries-guide) via search) Industry references note that **Curaçao/Anjouan‑tier regulators "do not require extensive game testing,"** which is exactly what lets an in‑house RGS approve content in ~24h. ([slotegrator.pro](https://slotegrator.pro/analytical_articles/seals-of-approval-gain-players-trust-with-certified-games/); [stakegame.info](https://stakegame.info/stakes-licenses-certifications/) via search)
- **Fairness is Stake's, not the developer's.** Stake's own crash/originals use **Stake's** provably‑fair framework (server seed + client seed + hash chain). ([thespike.gg](https://www.thespike.gg/reviews/stake-com/crash); [stakeslotus.org](https://stakeslotus.org/stake-crash/) via search) Third‑party RNG slots on Stake "operate on **those studios' RNG certifications**" and "are **not** provably fair in the cryptographic sense." ([track360.io](https://track360.io/blog/stake-com-operator-review-2026-crypto-casino-analysis)) For Stake **Engine** specifically, outcomes are decided by **Stake's RGS** sampling the developer's pre‑simulated books (§3), so the production RNG is Stake's, not ours.

### What this removes vs. what remains
- **Removed for a Stake‑only launch:** our own B2B/supplier **license** (Curaçao/MGA), our own **GLI‑19/iTech accredited RNG certificate**, the operator KYB/integration grind, and the seamless‑wallet build (Stake's RGS is the wallet). That is a large, real cost/time saving for *the Stake channel only*.
- **Remains / does NOT transfer:** publishing on Stake gives us **no certificate or license we can show another operator**. The moment we want to sell to a non‑Stake operator (our B2B thesis), we are back to needing our own cert + license — Stake Engine did nothing for that path. Our existing cert‑readiness evidence (1e9‑round sim, math spec, provably‑fair guide) stays relevant for *our* RGS path, **not** for Stake Engine (which doesn't ask for it).

### Confidence / caveats
- **HIGH** that no own license/own accredited cert is needed to publish on Stake, and that it rides Stake's Curaçao/Anjouan licenses.
- **MEDIUM (inference)** that the ~24h approval is *purely* internal QA with **no** accredited‑lab step. The docs only describe format/statistics "preliminary checks"; I found **no** primary text saying Stake does, or does not, run independent RNG testing on Engine games. **FLAG:** confirm via the live `stake-engine.com/docs/approval-guidelines` (which I could not render) or the developer agreement before relying on "zero external testing."
- The official **approval‑guidelines / developer ToS pages would not fetch** (JS‑rendered, returned only a "Loading…" shell). Several supporting points are from secondary coverage, not Stake's own text — flagged inline.

---

## 2. Exclusivity & distribution

### Findings
- **Contractually NON‑exclusive (well‑sourced).** Stake's terms are repeatedly described as **"no exclusivity, no lockups"** with the developer retaining "full control over their games"; "developers can publish their games on other platforms simultaneously." ([next.io](https://next.io/news/b2b-news/stake-unveils-new-stake-engine-build-launch-earn-the-engine-is-yours/) via search summary, page 403'd; [sharpr.substack.com](https://sharpr.substack.com/p/stake-wants-to-be-the-apple-of-casino); search summary of Gambling Insider [gamblinginsider.com](https://www.gamblinginsider.com/news/29242/stake-introduces-stake-engine-for-game-developers))
- **De‑facto exclusive in practice.** Engine titles are described as "available… **with crypto only on Stake.com**," and the program is framed as Stake "acquir[ing] **exclusive** independent content." Named Engine studios/titles (Twist Gaming — Win.exe, Kraken's Course; Titan Gaming — Wild Orbs; Massive Studios — Gold Mega Stepper; Paperclip Gaming — Borrowed Time; Mirror Image — Drop the Boss) appear as **Stake‑only releases**; no source shows them distributed to other operators. ([cryptogamba.com](https://cryptogamba.com/article/stake-engine-meet-providers-whose-games-are-exclusive-to-stake-com/); search summary of Stake Engine casino group [stake.com/casino/group/stake-engine](https://stake.com/casino/group/stake-engine), page 403'd)
- **The build targets Stake's own RGS + CDN.** Games are hosted at `https://{TeamName}.cdn.stake-engine.com/{GameID}/{GameVersion}/index.html?...&rgs_url={RgsUrl}` and call **Stake's** RGS endpoints (`/wallet/authenticate`, `/wallet/play`, `/wallet/end-round`, `/bet/event`). The `rgs_url` "should not be hardcoded, as it may change dynamically." ([stakeengine.github.io/RGS](https://stakeengine.github.io/math-sdk/rgs_docs/RGS/)) There is **no built‑in mechanism to point the same hosted build at another operator/aggregator** — distribution to others would mean re‑integrating the game with that operator's/aggregator's wallet+RGS separately.

### Reconciling the two (important nuance)
Both statements are true at different layers: **(a)** the *contract* does not forbid us shipping the same game elsewhere (we keep the IP and can re‑integrate it with our own RGS / another aggregator), but **(b)** the Stake Engine *artifact and channel* are Stake‑only — there is no "publish once, distribute to many operators" here. **Stake Engine is a single distribution endpoint, not an aggregator.** So "can we take the game elsewhere later?" → **Yes, the IP/right is ours; no, not the Stake‑hosted build as‑is — we'd rebuild the integration for each new operator** (which, for us, is exactly what our own RGS already does).

### Implications for our white‑label B2B ambition
- Stake Engine and our B2B/white‑label plan are **orthogonal**. Publishing on Stake Engine does not build us a multi‑operator distribution business; it makes us one more studio feeding Stake. Because terms are non‑exclusive, doing **both** is allowed — but the work doesn't compound: the Stake math‑book integration is throwaway relative to our own RGS.

### Confidence / caveats
- **HIGH** on "no exclusivity, no lockups" (≥3 outlets) and on "Engine games currently live only on Stake.com."
- **MEDIUM** on the exact contract wording — sourced from coverage, not the ToS itself (could not render). **FLAG:** verify the developer agreement for any quieter restrictions (e.g., a right‑of‑first‑refusal, a no‑clone clause, or platform‑data ownership) before assuming full freedom.

---

## 3. Game‑type acceptance (crash specifically) — the critical fit question

### Findings
- **No template restriction is claimed.** Coverage says Engine supports "slot, card game, wheel, etc." with "no templates, no restrictions." ([betensured.com](https://www.betensured.com/blog/stake-engine-what-it-is-and-how-it-works/); [igamingchronicle.com](https://igamingchronicle.com/stake-launches-stake-engine-to-reward-independant-game-developper/))
- **But the SDK/RGS model is pre‑simulated discrete books — not a live multiplier engine.** The required math files are: an `index.json` (mode name, **cost** multiplier, refs), a **CSV lookup table** of `simulation_number, round_probability, payout_multiplier`, and a compressed `.jsonl.zst` game‑logic file; each simulated round carries `"id", "events", "payoutMultiplier": <int>`. The doc states **"We require the payoutMultiplier value in the third column to exactly match those provided in the game‑logic file."** Outcomes are **selected from pre‑generated lookup tables**, weighted by an optimization algorithm to hit a target RTP — **not computed live**. ([stakeengine.github.io/data_format](https://stakeengine.github.io/math-sdk/rgs_docs/data_format/); [stakeengine.github.io/quickstart](https://stakeengine.github.io/math-sdk/math_docs/quickstart/)) The example explicitly: `games/0_0_lines/` = "a 3‑row, 5‑reel game paying on 20 win‑lines."
- **Every shipped sample is a slot.** Repo `games/` folders: `0_0_cluster`, `0_0_expwilds`, `0_0_lines`, `0_0_lines_feature_match`, `0_0_scatter`, `0_0_ways`, `fifty_fifty`, `template`. The web‑sdk samples are "lines/cluster/scatter/ways/price" — slot mechanics; the FE FAQ discusses "reel spinning and win calculations… no mention of other game genres." ([github.com/StakeEngine/math-sdk/tree/main/games](https://github.com/StakeEngine/math-sdk/tree/main/games); [github.com/StakeEngine/web-sdk](https://github.com/StakeEngine/web-sdk))
- **Stake's OWN Crash is a "Stake Original" built in‑house — NOT a Stake Engine game.** ([stake.com/casino/games/crash](https://stake.com/casino/games/crash) via search; [sportsgambler.com/originals](https://www.sportsgambler.com/review/stake/originals/)) So the existence of Crash on Stake.com is **not** evidence that the Engine SDK ships crash; it's a separate in‑house codebase.

### Why this matters for *our* crash game
Our crash is **continuous and interactive**: a multiplier rises in real time; the player **chooses when to cash out mid‑round**; the crash point comes from our **own eth‑block‑salted hash chain**; the payout is `bet × multiplier_at_cashout`. The Stake Engine model is the opposite shape: **the entire round outcome is pre‑decided** (a row sampled from a book) and the client animates it. Two hard questions, **neither answerable from the public docs**:
1. **Can a player's live cash‑out decision drive the payout?** The RGS flow is request `/wallet/play` (debit) → if win > 0, call `/wallet/end-round` (payout). I found a `/bet/event` endpoint "to track in‑progress player actions for disconnect recovery," which *hints* at multi‑step rounds — but **nothing confirming a continuous cash‑out‑at‑chosen‑moment mechanic**. ([stakeengine.github.io/RGS](https://stakeengine.github.io/math-sdk/rgs_docs/RGS/))
2. **Can a continuous crash multiplier be expressed as discrete books at all?** Possibly, by discretizing crash points into many buckets with matching probabilities/multipliers — but that would mean **abandoning our live RNG and our provably‑fair layer** and instead authoring a (large) static distribution that Stake's RGS samples. That is a re‑implementation of the game's core, not a port.

### Confidence / caveats
- **HIGH** that the SDK's documented model is pre‑simulated discrete books and that all public examples are slots.
- **HIGH** that Stake's own Crash is in‑house (Stake Originals), not an Engine title.
- **UNVERIFIED / #1 FLAG:** whether Stake Engine *accepts and supports a real‑time, player‑interactive crash with mid‑round cash‑out*, and whether a provably‑fair crash can be published. Coverage's "crash/provably‑fair as a target use case" claim (cited in our existing `b2b-market-and-compliance.md` from a Stake blog) is **not corroborated by the SDK docs**, which are slot‑shaped. **This must be validated hands‑on** (build a toy crash in the SDK, or ask Stake dev support) before betting on Stake Engine for our crash game.

---

## 4. Frontend SDK fit for our 3D (three.js/WebGL) game

### Findings — this is the most reassuring area
- **The PixiJS/Svelte frontend SDK is OPTIONAL.** The web‑sdk README: *"It is an **optional** way to build and launch your games… It is powered by Svelte 5, PixiJS 8 and TurboRepo."* And decisively: *"**You can use anything as long as it compiles to a static website**, it is only recommended to use the web‑sdk for the easiest development and integration experience as everything is already set up for you, but you can also just fork it."* ([github.com/StakeEngine/web-sdk](https://github.com/StakeEngine/web-sdk))
- **Own frontend + own math are explicitly allowed.** *"Developers utilizing their **own frontend and/or math solutions** are welcome to upload compatible file‑formats to the Admin Control Panel (ACP)."* The only hard constraint is that *"games uploaded to Stake Engine must consist of **static files**."* ([stakeengine.github.io/fe_home](https://stakeengine.github.io/math-sdk/fe_home/) per search summary + web‑sdk README)
- **The RGS contract is plain REST.** The connection example is built in "Svelte 5 with Vite" but "provides no statement constraining frontend technology… focuses on calling REST endpoints rather than prescribing specific rendering frameworks." Round flow: `/wallet/authenticate` → `/wallet/play` → (if win) `/wallet/end-round`. ([stakeengine.github.io/simple_example](https://stakeengine.github.io/math-sdk/simple_example/simple_example/); [stakeengine.github.io/RGS](https://stakeengine.github.io/math-sdk/rgs_docs/RGS/))

### What this means for our existing 3D React/three.js client
- **Renderer reuse: largely feasible.** Our three.js/WebGL scene can be kept and built to static files (the existing build already produces a static bundle). We are **not** forced onto PixiJS. **No source mentions 3D/WebGL as unsupported** (and none mentions it as supported either — FLAG, but "anything that compiles to static" is the governing rule).
- **The real rebuild is the control‑flow inversion, not the graphics.** Today our client streams live tick/multiplier state from *our* engine and sends a live cash‑out. On Stake Engine the client would: authenticate → call `/wallet/play` → receive a **pre‑decided** round result (the sampled book row) → **animate that predetermined outcome** → call `/wallet/end-round`. So our three.js *visuals* survive; our **client↔server protocol, the live‑tick engine, and the cash‑out timing model would be re‑architected** to "play back" an outcome Stake's RGS already chose. For a crash game this is the same fundamental tension as §3 — the *interactivity* is the hard part, not the rendering tech. React/Svelte difference is minor; the SDK is optional so we needn't adopt Svelte.

### Confidence / caveats
- **HIGH** that the frontend SDK is optional and that any framework compiling to static files is accepted (primary: web‑sdk README).
- **MEDIUM** on practical 3D viability at scale — no source explicitly validates a heavy three.js/WebGL title on Stake Engine; the platform's stated value is "lightweight… instant‑play… any mobile browser," which *culturally* favors light 2D. **FLAG:** confirm there's no bundle‑size/asset cap or perf gate that would penalize a 3D build (the docs mention games must be static files but I saw no explicit size limit).

---

## 5. Commercial terms

### Findings
- **10% of GGR, monthly, no hidden fees — the headline is well‑sourced and consistent.** "Developers earn a set 10% of all gross gaming revenue… paid monthly and no hidden costs," "10% GGR **perpetual** royalties," "zero lockups, no hidden fees." ([next.io](https://next.io/news/b2b-news/stake-unveils-new-stake-engine-build-launch-earn-the-engine-is-yours/) & Gambling Insider [gamblinginsider.com](https://www.gamblinginsider.com/news/29242/stake-introduces-stake-engine-for-game-developers) via search summaries; [stake-engine.com](https://stake-engine.com/) per our existing doc; [sharpr.substack.com](https://sharpr.substack.com/p/stake-wants-to-be-the-apple-of-casino)) Contrast framing: legacy provider royalties ~12–18%+ (some report 20–30%). ([bitcoinchaser.com](https://bitcoinchaser.com/inside-stake-engine/) per our existing doc)
- **Developer keeps IP.** "Developers retain full control over their games," "full ownership retained." ([sharpr.substack.com](https://sharpr.substack.com/p/stake-wants-to-be-the-apple-of-casino)) (Our existing `b2b-market-and-compliance.md` already logs the 10% figure as the best‑sourced independent‑RGS comparable.)
- **No upfront fee surfaced; SDK is free/open and now open‑access.** No source mentions a setup fee, minimum guarantee, or seat cost; the SDK is public on GitHub under **MIT** (math‑sdk). ([github.com/StakeEngine/math-sdk](https://github.com/StakeEngine/math-sdk))

### Reading the "10%" correctly (don't mis‑model it)
The 10% is what **Stake (the platform) takes from the developer's game GGR** — i.e. the developer keeps ~90% of the GGR *that game books on Stake.com*. This is **not** comparable to "a supplier's 11–26% cut of operator GGR" in the normal B2B model; here Stake **is** the operator and books the GGR, and 10% is the platform/RGS/distribution cut it retains. So "we keep 90%" only applies to volume **on Stake.com** — it says nothing about revenue we'd earn distributing our own RGS to other operators.

### Confidence / caveats
- **HIGH** on 10% GGR / monthly / no hidden fees / IP retained (≥3 outlets + our prior doc).
- **MEDIUM** on "*no* other obligations." The actual **developer agreement** (payment terms, chargeback/fraud handling, takedown rights, data ownership, dispute/refund liability, who eats negative‑GGR months) was **not readable**. **FLAG:** the binding terms live in the ToS we couldn't render — review before signing. "No hidden fees" is a marketing line, not a contract we verified.

---

## 6. Jurisdiction / market reach

### Findings
- **Stake runs on Curaçao (master) + Anjouan, plus local licenses.** Master: **Curaçao GCB, Medium Rare N.V., OGL/2024/1451/0918**; secondary **Anjouan**; plus local licenses in **Brazil, Colombia, Mexico, Peru, Denmark** and others. ([worldpokerdeals.com](https://worldpokerdeals.com/blog/stake-countries-guide) & [track360.io](https://track360.io/blog/stake-com-operator-review-2026-crypto-casino-analysis) via search; [stake.com/licenses](https://stake.com/licenses))
- **Explicitly NOT the Tier‑1 regulated markets.** Stake blocks the **US, UK, France, Spain, Germany, Italy, the Netherlands, Australia** (and Ontario). The operator review states plainly: **"Neither license satisfies the equivalency standards of the Malta Gaming Authority (MGA), UK Gambling Commission (UKGC), ADM (Italy), or GGL (Germany)."** ([track360.io](https://track360.io/blog/stake-com-operator-review-2026-crypto-casino-analysis))
- **Scale of the channel:** Stake.com reports ~**$4B+ GGR (2025)**, the highest‑revenue crypto casino; coverage cites a **~20–36M registered user** base and Engine games having driven **~$3.31B turnover** in 12 months across **6,000+ registered developers**. ([track360.io](https://track360.io/blog/stake-com-operator-review-2026-crypto-casino-analysis); Gambling Insider / Stake blog via search summaries) — treat the user/turnover numbers as **promotional, single‑source‑ish** (FLAG).

### What it means for our B2B targets
- **Realistic addressable market via Stake Engine = the Stake ecosystem only** (crypto‑first, LATAM/SEA/Africa/CA/NZ + Stake's local‑licensed BR/CO/MX/PE/DK). That's a **large player base** but **one operator**.
- It does **NOT** advance any MGA/UKGC/ADM/Germany goal — those are exactly the markets Stake can't serve. If our B2B thesis includes selling to MGA/UKGC operators, Stake Engine contributes **nothing** to that and we still need our own cert + supplier license (see our `b2b-market-and-compliance.md` §4–5).
- Net: Stake Engine's reach **overlaps** our own Curaçao‑tier ceiling rather than extending it — but as a *tenant* of Stake, not as a *supplier* with our own license. The strategic question is whether we want one big distribution endpoint now vs. building the multi‑operator supplier business.

### Confidence / caveats
- **HIGH** on the license stack and the "not MGA/UKGC/ADM/GGL" exclusion (primary‑ish operator review + Stake's own licenses page).
- **MEDIUM** on the headline scale numbers (promotional). Use as order‑of‑magnitude, not precise.

---

## 7. Onboarding & risk

### Findings — onboarding
- **Open self‑serve registration now (was invite‑only).** Sign up at **engine.stake.com**, access the dashboard/ACP, build with the SDK, upload static files, submit; approval in ~24h–2 days. ([stakecommunity.com "open to everyone"](https://stakecommunity.com/topic/149516-stake-engine-is-now-open-to-everyone-is-this-a-strategic-and-benefic/); search summaries of [igamingchronicle.com](https://igamingchronicle.com/stake-launches-stake-engine-to-reward-independant-game-developper/) and the Stake blog) Real‑world signal: there are freelancers selling "build a Stake‑Engine‑submission slot frontend" gigs, implying a low practical barrier to submit. ([freelancer.com listing](https://www.freelancer.com/projects/svelte/front-end-developer-wanted-build))
- **Company/KYC requirements for developers: NOT documented publicly.** I found **no** primary statement on whether a developer must be an incorporated entity, pass KYB/UBO, or how payouts are KYC'd. **FLAG (gap).** Given Stake pays real GGR royalties, expect *some* payee KYC/AML and likely an entity + bank/crypto‑payout setup — but this is **inference**, not sourced.

### Findings — risks (honest)
- **Platform lock‑in / single distributor.** Engine games live only on Stake.com via Stake's RGS/CDN; there is no portable distribution. Revenue depends on **one** counterparty's traffic, merchandising (where Stake ranks your game), and continued operation. Even with non‑exclusivity, the *build* doesn't travel. (§2)
- **Terms‑change risk.** 10%/no‑lockup are *current* marketing terms on a young (2025‑launched) program; the binding ToS weren't readable and can change. A platform that is "the Apple of casino games" sets the rules. ([sharpr.substack.com](https://sharpr.substack.com/p/stake-wants-to-be-the-apple-of-casino))
- **Regulatory cloud around Stake.** Crypto‑casino, Curaçao/Anjouan‑tier, blocked in the US/UK/most of regulated EU; coverage calls the Curaçao license "notoriously lax." ([igamingchronicle.com](https://igamingchronicle.com/stake-launches-stake-engine-to-reward-independant-game-developper/); [track360.io](https://track360.io/blog/stake-com-operator-review-2026-crypto-casino-analysis)) Reputationally, "publishes on Stake" is a different brand signal than "MGA‑certified B2B supplier" — relevant if we later court Tier‑1 operators.
- **Loss of our differentiators.** Our **provably‑fair eth‑block salt oracle** and our **own RNG/HA engine** are **not used** on Stake (Stake's RGS + Stake's fairness win). The very things we built as moats become inert in this channel.
- **Math‑model dependency.** If §3's crash‑fit question resolves negatively, "publishing our crash on Stake Engine" may require re‑expressing the game as discrete books — a genuine re‑build, not a port.

### Confidence / caveats
- **HIGH** that onboarding is now open self‑serve. **UNVERIFIED:** developer KYB/KYC/entity requirements and payout mechanics (gap — not in public docs).
- Risks are **analysis/inference grounded in sourced facts** (lock‑in follows from the RGS/CDN model; regulatory tier is sourced). The "notoriously lax" characterization is one outlet's wording.

---

## How our existing assets map onto Stake Engine (and the gaps)

| Our asset | On Stake Engine | Verdict |
|---|---|---|
| **NestJS RGS** (operator seamless wallet, sessions, launch tokens) | **Not used** — Stake's RGS is the server + wallet | Redundant in this channel; remains the core of our *own* B2B path |
| **Provably‑fair eth‑block salt + SHA‑256 chain** | **Not used** — Stake's own server/client‑seed hash chain governs fairness | Differentiator goes inert; we'd be "just another studio" on fairness |
| **HA engine / leader‑election / load‑tested scale** | **Not used** — Stake operates the infra ("1M+ bets/sec") | Redundant in this channel |
| **3D React/three.js frontend** | **Reusable** — "anything that compiles to a static website" is allowed; SDK is optional | **Best‑fitting asset**; needs control‑flow rework (animate a pre‑decided outcome) not a graphics rewrite |
| **Crash math (RTP 97%, P(crash≥x)=0.97/x), 1e9 sim, math spec** | **Partially reusable as design**, but must be re‑expressed as **discrete pre‑simulated books**; Stake doesn't consume our sim report | Re‑authoring of the math into Stake's format; live‑RNG model dropped |
| **Cert‑readiness evidence (sim/spec/PF guide)** | **Not requested** by Stake (no accredited cert step) | Irrelevant to Stake channel; still valuable for our own RGS/cert path |
| **B2B trust package (#3 sandbox, #4/#5 operator APIs, docs)** | **Not used** — there is no "operator" to integrate; Stake is the operator | Redundant in this channel; central to our supplier business |

**Reading the table:** almost everything we built (RGS, wallet, PF oracle, HA, operator APIs, cert‑readiness) exists to be a **B2B supplier**. Stake Engine asks for **none** of it — it asks for game **math books** + a static frontend. The only Vault Run asset that ports cleanly is the **3D frontend**. That asymmetry is the decision: Stake Engine monetizes our *game*, not our *platform*.

---

## What remains UNVERIFIED / could not be sourced (flag before any decision)

1. **#1 — Crash fit:** whether Stake Engine actually accepts/supports a **real‑time, player‑interactive crash with mid‑round cash‑out** and a provably‑fair crash. The SDK docs are slot/discrete‑book shaped; coverage's "crash is a target use case" is **uncorroborated by the docs**. **Validate hands‑on or with Stake dev support.**
2. **Approval rigor:** whether the ~24h approval is *purely* internal QA with **no** accredited‑lab RNG testing. Docs only show format/statistics checks; no primary statement either way. (`approval-guidelines` page wouldn't render.)
3. **Developer agreement / ToS:** the **binding** commercial terms (payment, refund/chargeback liability, negative‑GGR handling, takedown, data ownership, any right‑of‑first‑refusal or no‑clone clause). All commercial/exclusivity facts here are from **coverage**, not the contract.
4. **Developer KYB/KYC & payout mechanics:** entity requirement, UBO checks, how royalties are paid out and KYC'd — **no public source.**
5. **3D at scale:** any asset‑size/perf constraints that would penalize a heavy three.js/WebGL build (platform culture favors lightweight 2D; no explicit cap found).
6. **Scale claims** (20–36M users, $3.31B Engine turnover, 6,000+ devs, 1M+ bets/sec) are **promotional/single‑source** — order‑of‑magnitude only.
7. **Official `stake-engine.com/docs/*` and the Stake blog** could not be fetched as text (JS‑render / 403). Re‑attempt with a JS‑capable fetch or a logged‑in dashboard for §1–§5 confirmations.

---

## Sources

**Stake Engine — primary (GitHub docs & repos)**
- https://stakeengine.github.io/math-sdk/rgs_docs/RGS/ (RGS API: seamless wallet endpoints; hosted CDN URL; `rgs_url` dynamic; `/bet/event` disconnect recovery)
- https://stakeengine.github.io/math-sdk/rgs_docs/data_format/ (required math files: index.json + CSV `sim,prob,payout_multiplier` + `.jsonl.zst`; discrete integer multipliers; "preliminary checks… of the expected format")
- https://stakeengine.github.io/math-sdk/math_docs/quickstart/ (slot sample `0_0_lines`; RTP via optimization weights on pre‑simulated outcomes)
- https://stakeengine.github.io/math-sdk/simple_example/simple_example/ (RGS connection: REST flow `/play`→`/end-round`; frontend tech not constrained)
- https://stakeengine.github.io/math-sdk/fe_home/ (frontend SDK; "own frontend and/or math" allowed; "static files" requirement)
- https://github.com/StakeEngine/web-sdk ("optional… Svelte 5, PixiJS 8"; **"use anything as long as it compiles to a static website… you can also just fork it"**; samples are slot mechanics)
- https://github.com/StakeEngine/math-sdk (MIT license; Python math engine; `games/` = slot variants)
- https://github.com/StakeEngine/math-sdk/tree/main/games (sample list: cluster/expwilds/lines/scatter/ways/fifty_fifty/template — all slots)
- https://stake-engine.com/ (10% GGR; homepage — JS‑rendered, only "Loading…" recovered)
- https://stake-engine.com/docs/approval-guidelines ; https://stake-engine.com/docs (JS‑rendered, **could not read** — flagged)

**Stake Engine — coverage (secondary)**
- https://www.betensured.com/blog/stake-engine-what-it-is-and-how-it-works/ (game types "slot, card game, wheel, etc."; ~24h–2‑day approval; PixiJS/Svelte; multi‑currency)
- https://sharpr.substack.com/p/stake-wants-to-be-the-apple-of-casino ("no exclusivity, no lockups"; IP retained; "Apple of casino games"; lock‑in framing)
- https://igamingchronicle.com/stake-launches-stake-engine-to-reward-independant-game-developper/ (10% GGR perpetual; was invite‑only/waitlist; "Curaçao… notoriously lax"; scale claims)
- https://cryptogamba.com/article/stake-engine-meet-providers-whose-games-are-exclusive-to-stake-com/ ("exclusive to Stake.com"; named studios/titles — all slot‑style)
- https://stakecommunity.com/topic/149516-stake-engine-is-now-open-to-everyone-is-this-a-strategic-and-benefic/ (SDK now open to everyone)
- https://www.gamblinginsider.com/news/29242/stake-introduces-stake-engine-for-game-developers (10% GGR; 403'd — via search summary)
- https://next.io/news/b2b-news/stake-unveils-new-stake-engine-build-launch-earn-the-engine-is-yours/ ("no exclusivity, no lockups"; 403'd — via search summary)
- https://stake.com/blog/what-is-stake-engine (official explainer; 403'd — via search summary)
- https://www.freelancer.com/projects/svelte/front-end-developer-wanted-build (real‑world "build a Stake‑Engine slot frontend" gig)

**Stake Crash = in‑house (not Engine)**
- https://stake.com/casino/games/crash ; https://www.sportsgambler.com/review/stake/originals/ (Crash is a Stake Original, built in‑house)
- https://www.thespike.gg/reviews/stake-com/crash ; https://stakeslotus.org/stake-crash/ (Stake Crash provably‑fair via Stake's own seed/hash chain, 99% RTP)

**Jurisdiction / scale / compliance tier**
- https://track360.io/blog/stake-com-operator-review-2026-crypto-casino-analysis (Curaçao GCB + Anjouan; **blocks US/UK/FR/ES/DE/IT/NL/AU**; **"Neither license satisfies… MGA, UKGC, ADM, or GGL"**; ~$4B+ GGR 2025; third‑party slots run on studios' own RNG certs)
- https://worldpokerdeals.com/blog/stake-countries-guide ; https://stake.com/licenses (Curaçao OGL/2024/1451/0918; Anjouan; local BR/CO/MX/PE/DK)
- https://slotegrator.pro/analytical_articles/seals-of-approval-gain-players-trust-with-certified-games/ (Curaçao/Anjouan‑tier "do not require extensive game testing")
- https://stakegame.info/stakes-licenses-certifications/ (Stake's Curaçao licensing posture)

**Internal cross‑reference**
- `/Users/artem/Documents/crash game/vault-runner-api/docs/research/b2b-market-and-compliance.md` (the 10% GGR comparable, GLI‑19/iTech cert path, Curaçao/MGA supplier licensing — for our *own* RGS route)
