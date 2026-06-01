# Vault Run — Game Math Specification

**Version:** 1.0  ·  **Date:** 2026-06-01  ·  **Status:** draft (pre-certification)
**Game type:** Crash · **Theme:** bank heist · **RTP:** 97% · **House edge:** 3%

Companion documents: `simulation-report.md` (empirical validation),
`../../vault-runner-main/docs/production-roadmap.md` (B2B roadmap),
in-code source of truth: `src/fairness/crash.ts`, `src/game/game-engine.service.ts`,
`src/game/bets.service.ts`.

---

## 1. Game overview

Vault Run is a server-authoritative multiplayer crash game. A shared round runs
on one global clock; all players see the same rising multiplier and the same
crash point. A player places up to two independent bets per round and cashes
each out before the round crashes. The crash point is determined before the
round starts by a provably-fair, verifiable function of a committed seed and a
salt — the server cannot change it after betting closes.

---

## 2. Game rules

- A round has a single **crash multiplier** ≥ 1.00x, hidden until reached.
- During **betting**, a player may place a bet on either or both panels
  (Quick Grab, Big Heist). Each bet has an `amount` and an optional
  `autoCashout` target.
- During **running**, the multiplier rises from 1.00x. A player may **cash out**
  manually at the live multiplier, or have the server **auto-cash-out** at their
  exact target.
- If the multiplier reaches the crash point while a bet is still active, that
  bet is **busted** (loses its stake).
- Winnings = `stake × cash-out multiplier`, subject to the limits in §12.

---

## 3. Round lifecycle

Phases and durations (from `game-engine.service.ts`, `PHASE_MS`):

| Phase | Duration | Description |
|---|---|---|
| `waiting` | 3.0 s | Inter-round pause; next round id + seed allocated. |
| `betting` | 5.0 s | Bets accepted on both panels. |
| `running` | variable | Multiplier rises until the crash point is reached. |
| `crashed` | 2.5 s | Crash shown; active bets settled as busted. |
| `settling` | 0.5 s | Bookkeeping. |
| `completed` | ~0.6 s | Seed revealed; round closed. |

**Multiplier pacing:** `multiplier(t) = e^(GROWTH · elapsedMs)`, `GROWTH = 0.00012`,
floored to 2 decimals: `max(1.00, floor(e^(GROWTH·Δt) · 100) / 100)`. Pacing is
**cosmetic only** — it sets how fast the curve visibly rises, *not* the crash
point. The running phase ends at `crashDelay = ln(crashPoint) / GROWTH`.

---

## 4. Bet types (dual-bet)

Two **independent bet positions** share **one crash point** per round:

- **Quick Grab** (panel A) and **Big Heist** (panel B).
- Each has its own `amount`, `autoCashout`, and cash-out state.
- A player may bet one or both; cash each out independently.
- Both reference the same round crash point — they are not two separate games.
- **Per-round player exposure** = sum of both panels' potential wins, each
  capped per §12.

Enforced uniqueness: one bet per `(roundId, userId, panel)`.

---

## 5. RTP and house edge

- **House edge** `= 0.03` (`HOUSE_EDGE` in `crash.ts`).
- **RTP** `= 1 − houseEdge = 0.97` (97%).
- Distribution: `P(crash ≥ x) = 0.97 / x` for `x ≥ 1.00`.
- For any auto-cashout target `t > 1`, expected return `= t · P(crash ≥ t) = 0.97`
  — RTP is constant across strategies (hallmark of a fair crash curve).
- Empirically validated to 97.0% ± 0.1% over 1e8 rounds — see
  `simulation-report.md`.

---

## 6. Crash distribution

`P(crash ≥ x) = 0.97 / x`. Consequences:

- `P(crash = 1.00x)` (instant bust) `= 1 − 0.97/1.01 = 3.96%` (everything below
  1.01x floors to 1.00x). **This is 3.96%, not 3%** — the 3% is the house edge.
- `P(crash ≥ 2x) = 48.5%`, `≥ 10x = 9.70%`, `≥ 100x = 0.97%`,
  `≥ 1000x = 0.097%`, `≥ 10000x = 0.0097%`.
- Full probability table: `simulation-report.md` §4.

---

## 7. Crash multiplier formula

From `src/fairness/crash.ts` (authoritative):

```
E       = 2^52
FACTOR  = round(100 · (1 − houseEdge)) = 97          // "cents"
h       = top 13 hex chars of HMAC_SHA256(key=seed, msg=salt)  // 52-bit int [0, 2^52)
cents   = floor( FACTOR · (E + 1) / (h + 1) )         // BigInt floor division
cents   = clamp(cents, 100, MAX_CENTS)                // 1.00x .. cap
crash   = cents / 100                                 // 2 decimals
```

- All arithmetic is **BigInt** until the final `/100` — no float rounding bias.
- `h+1` and `E+1` avoid division-by-zero and keep the support exact.
- `MAX_CENTS = 100,000,000` (1,000,000.00x) in the **demo**; **10,000.00x** in
  real-money config (§12).

---

## 8. Payout calculation

From `bets.service.ts`:

```
payout = floor( amount · cashOutMultiplier )          // integer minor units
```

- `amount` is in integer **minor units** of the bet's currency (cents for EUR/USD,
  10^-6 for USDT, satoshis for BTC, etc.); payouts floor to minor units —
  rounding is always **in the house's favour** (down).
- Net player result = `payout − amount` (the stake was debited at bet time).
- Subject to max-win caps in §12.

**Currency independence.** The math (crash distribution, RTP, multiplier curve,
payout = stake × multiplier) is **currency-agnostic** — it operates purely on
integer minor units. A 2x cash-out doubles the stake whether it is EUR, USD,
USDT, or BTC. Only the **money limits** (§12) are per-currency, and they live in
the operator's bet-level tables, not in the math. One math model → many
currencies.

---

## 9. Auto-escape (auto cash-out) logic

- A bet may set `autoCashout = t` (`t > 1`).
- Each engine tick, `evaluateAutoCashouts(currentMultiplier)` selects active bets
  with `autoCashout ≤ currentMultiplier` and cashes them at their **exact target
  `t`** (not the live tick value) — deterministic, tick-jitter-independent.
- Idempotent: payout keyed `bet:{id}:payout`; a bet cashes out at most once.

---

## 10. Manual cash-out logic

- Allowed only during `running` for an active (placed, not cashed/busted) bet.
- Pays at the **live** multiplier (`engine.currentMultiplier()`) at the moment
  the server processes the request — server-authoritative; the client value is
  never trusted.
- Race rules: a manual cash-out after the crash event is rejected (`too_late`);
  a manual + auto race resolves to one payout (status flips to `cashed_out`,
  filtered from the next auto tick). Verified in the engine tests.

---

## 11. Rounding rules

- **Crash multiplier:** floored to 2 decimals (`floor(cents)/100`).
- **Payout:** floored to integer minor units (`floor(amount · mult)`).
- All rounding is **downward (toward the house)** — never rounds a payout up.
- No floating-point in the crash derivation (BigInt throughout).

---

## 12. Max win / max multiplier / limits (multi-currency)

The game is **multi-currency from day one**. The crash math is shared and
currency-agnostic (§8); only these money limits are **per-currency**, configured
in the operator's **bet-level tables**. An operator enables whichever currencies
it offers; each carries its own row.

**Currency-independent:**

| Parameter | Value |
|---|---|
| Max multiplier | 10,000x (real-money) / 1,000,000x (demo) |

**Per-currency limits (bet-level tables).** EUR is the **reference** row; other
rows are set per FX/operator policy and stored in minor units. Indicative values:

| Currency | Minor unit | Min bet | Max bet | Max win / bet | Max win / player·round | Exposure cap / round |
|---|---|---|---|---|---|---|
| EUR (ref) | cent (10⁻²) | €0.10 | €100 | €10,000 | €20,000 | €100,000 |
| USD | cent (10⁻²) | $0.10 | $100 | $10,000 | $20,000 | $100,000 |
| USDT | 10⁻⁶ | 0.10 | 100 | 10,000 | 20,000 | 100,000 |
| BTC | sat (10⁻⁸) | per FX | per FX | per FX | per FX | per FX |
| ETH | wei-scaled | per FX | per FX | per FX | per FX | per FX |

- **Effective max multiplier per bet** = `maxWinPerBet / bet` (currency-relative).
  E.g. on the EUR row: €0.10→100,000x, €1→10,000x, €10→1,000x, €100→100x. The
  per-bet cap limits the **absolute win**, not RTP (`simulation-report.md` §5).
- **Max win per player per round** = 2 × max-win-per-bet (both panels).
- **Operator exposure cap:** the engine rejects new bets once the round's
  aggregate potential payout (summed across players, per currency or in a
  reference currency) would exceed the cap — house bankroll safeguard (roadmap
  Phase 1).
- Crypto rows convert via the operator's FX policy at launch; the spec does not
  fix crypto thresholds (they track volatile FX). The live **demo** uses
  play-money limits, not these.

---

## 13. Refund & error handling

- **Bet cancellation** during `betting`: full refund, keyed `bet:{id}:refund`
  (idempotent credit).
- **Round void / engine fault** before settlement: all stakes refunded; no round
  result recorded. (Recovery path; Phase 1.)
- **Operator wallet timeout after debit:** idempotent retry; if ambiguous, a
  compensating rollback + reconciliation flag — never a silent double charge
  (seamless-wallet contract; Phase 0).
- **Insufficient balance / invalid amount:** bet rejected before the round runs;
  no state change.
- All money moves are append-only and idempotency-keyed; no negative balances.

---

## 14. Provably-fair method

- **Seed chain (bustabit-style):** `seed[k] = SHA256(seed[k+1])`; the chain head
  (`seed[0]`) is the public **commitment**, published before any round in the
  chain plays. Rounds consume seeds forward; revealing `seed[k]` lets anyone
  verify `SHA256(seed[k]) == seed[k-1]` back to the commitment, proving no seed
  was swapped.
- **Crash derivation:** `crash = f(HMAC_SHA256(key=seed, msg=salt))` per §7.
- **Salt:** demo uses a published daily salt; real-money upgrades to a future
  blockchain block hash (grind-proof) — `SaltProvider` is an interface, one
  class swap (roadmap Phase 2).
- **Reveal:** the round's seed is revealed at `completed`; a browser verifier
  (`vault-runner-main/src/lib/fairness.ts`, `/fairness` page) recomputes the
  crash with no trust in the server.
- Full step-by-step + worked example: **Provably-Fair Verification Guide**
  (roadmap Phase 6 deliverable).

---

## 15. Simulation results

Summary (full report: `simulation-report.md`):

- 1e8 rounds through the **exact production formula**.
- Nominal RTP **96.99–97.04%** across all cash-out targets; house edge 3.00%.
- Instant-bust **3.956%** (matches `1 − 0.97/1.01`).
- `P(crash ≥ x)` matches `0.97/x` to 3–4 significant figures from 1.01x to 10,000x.
- Reproduce: `bun scripts/simulate-rtp.ts 100000000`.

---

## 16. Versioning

- **v1.0** (2026-06-01) — initial spec; demo cap 1,000,000x, real-money config
  10,000x / €10,000 max-win-per-bet (EUR reference). Multi-currency from day one:
  currency-agnostic math + per-currency bet-level tables. Math source:
  `crash.ts` (HOUSE_EDGE 0.03).
- Any change to `HOUSE_EDGE`, the crash formula, caps, rounding, or phase timing
  **must** bump this version and trigger a re-run of the Simulation Report and a
  re-certification review.
