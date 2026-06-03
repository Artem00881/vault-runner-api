/**
 * RTP / distribution simulation for the Game Math Specification.
 *
 * IMPORTANT: this imports the EXACT production crash function
 * (src/fairness/crash.ts) — it never re-implements the math. Each round uses a
 * fresh random seed run through the real HMAC→crash pipeline, exactly as the
 * live engine allocates seeds from its chain.
 *
 * Run:  bun scripts/simulate-rtp.ts [rounds]
 *   e.g. bun scripts/simulate-rtp.ts 100000000
 *
 * Output: theoretical vs observed RTP (uncapped), instant-bust %, a probability
 * table P(crash ≥ x), and the CAPPED effective RTP per bet size given the
 * production €10,000 max-win-per-bet rule.
 */
import { randomBytes } from "node:crypto";
import { computeCrash, HOUSE_EDGE } from "../src/fairness/crash";

const ROUNDS = Number(process.argv[2] ?? 10_000_000);
const SALT = "vault-run-sim-salt-v1"; // fixed salt; seeds are random per round

// Production money rules (real-money config) for the capped-RTP analysis.
const MAX_WIN_PER_BET_EUR = 10_000;
const BET_SIZES_EUR = [0.1, 1, 10, 100];

// Probability-table thresholds.
const THRESHOLDS = [1.01, 1.5, 2, 3, 5, 10, 20, 50, 100, 1000, 10000];

// --- accumulators ---
let sumCrash = 0; // Σ crash  (E[crash] → uncapped RTP via strategy below)
let instantBust = 0; // crash == 1.00x
let maxSeen = 1;
const atLeast: Record<number, number> = {};
THRESHOLDS.forEach((t) => (atLeast[t] = 0));

// For "bet to the very end" RTP: a player who never cashes out wins crash×bet
// only conceptually — but RTP of crash is defined via the cash-out strategy.
// The clean, strategy-independent RTP estimator for this distribution is
// E[min(crash, target)]/target averaged over targets; instead we use the
// standard identity: for an auto-cashout at target t (t>1), payout = t if
// crash≥t else 0, so RTP(t) = t·P(crash≥t). We report RTP(t) across targets to
// show it's ~constant 97% (the hallmark of a fair crash curve), plus the capped
// version per bet size.

// Capped-RTP, done correctly. RTP is defined per cash-out strategy: for an
// auto-cashout at target t with bet b, payout = min(t·b, MAX_WIN) when crash≥t.
// So RTP(t,b) = min(t, MAX_WIN/b)·P(crash≥t).
//   • For any target t ≤ effMax (= MAX_WIN/b) the cap never binds → RTP ≈ 97%.
//   • Setting t above effMax is irrational (you cap your win yet take more risk)
//     and yields LESS than 97% — that's the only place the cap "lowers" RTP.
// We report RTP(t,b) across targets per bet size to show it holds ~97% up to
// effMax and only declines if a player pushes past it.
const CAPPED_TARGETS = [2, 5, 10, 100, 500, 1000, 5000];
// count P(crash≥t) for these targets too
const cappedAtLeast: Record<number, number> = {};
CAPPED_TARGETS.forEach((t) => (cappedAtLeast[t] = 0));

const t0 = Date.now();
for (let i = 0; i < ROUNDS; i++) {
  const seed = randomBytes(32).toString("hex");
  const crash = computeCrash(seed, SALT + ":" + i);
  sumCrash += crash;
  if (crash <= 1.0) instantBust++;
  if (crash > maxSeen) maxSeen = crash;
  for (const t of THRESHOLDS) if (crash >= t) atLeast[t]++;
  for (const t of CAPPED_TARGETS) if (crash >= t) cappedAtLeast[t]++;

  if ((i + 1) % 5_000_000 === 0) {
    process.stderr.write(`  …${((i + 1) / 1e6).toFixed(0)}M rounds\n`);
  }
}

const secs = (Date.now() - t0) / 1000;
const pct = (n: number) => ((n / ROUNDS) * 100).toFixed(4) + "%";

// RTP(t) = t · P(crash ≥ t). For a fair curve this is ~ (1 - houseEdge) for all t>1.
const rtpAtTarget = (t: number) => t * (atLeast[t] / ROUNDS);

console.log("\n===== Vault Run — Crash RTP / Distribution Simulation =====");
console.log(`rounds:            ${ROUNDS.toLocaleString()}`);
console.log(`elapsed:           ${secs.toFixed(1)}s (${Math.round(ROUNDS / secs).toLocaleString()}/s)`);
console.log(`house edge (cfg):  ${(HOUSE_EDGE * 100).toFixed(2)}%`);
console.log(`theoretical RTP:   ${((1 - HOUSE_EDGE) * 100).toFixed(2)}%`);
console.log(
  `instant-bust 1.00x:${" "}${pct(instantBust)}  ` +
    `(theory ≈ 3.96% = 1 − 0.97/1.01, the P(crash<1.01x) clamp mass — NOT the ${(HOUSE_EDGE * 100).toFixed(0)}% house edge; audit L3)`,
);
console.log(`max crash seen:    ${maxSeen.toFixed(2)}x`);

console.log("\n--- Uncapped RTP via auto-cashout targets  RTP(t) = t·P(crash≥t) ---");
console.log("  target     P(crash≥t)     RTP(t)");
for (const t of [1.5, 2, 5, 10, 100, 1000]) {
  console.log(
    `  ${t.toString().padStart(6)}x    ${pct(atLeast[t]).padStart(10)}    ${(rtpAtTarget(t) * 100).toFixed(3)}%`,
  );
}

console.log("\n--- Probability table  P(crash ≥ x) ---");
console.log("  multiplier     probability     (theory 0.97/x)");
for (const t of THRESHOLDS) {
  const theory = Math.min(1, 0.97 / t) * 100;
  console.log(
    `  ${(t + "x").padStart(8)}     ${pct(atLeast[t]).padStart(10)}     ${theory.toFixed(4)}%`,
  );
}

console.log("\n--- Capped RTP per bet size & cash-out target (€10,000 max-win-per-bet) ---");
console.log("  RTP(t,b) = min(t, €10,000/b)·P(crash≥t). '·' = target above the");
console.log("  bet's effective max — capping your own win, so RTP drops there.");
const head = "  target │ " + BET_SIZES_EUR.map((b) => `€${b}`.padStart(8)).join(" ");
console.log(head);
console.log("  " + "─".repeat(head.length - 2));
for (const t of CAPPED_TARGETS) {
  const p = cappedAtLeast[t] / ROUNDS;
  const cells = BET_SIZES_EUR.map((b) => {
    const effMax = MAX_WIN_PER_BET_EUR / b;
    const rtp = Math.min(t, effMax) * p;
    const mark = t > effMax ? "·" : " ";
    return (mark + (rtp * 100).toFixed(2) + "%").padStart(8);
  });
  console.log(`  ${(t + "x").padStart(6)} │ ${cells.join(" ")}`);
}
console.log(
  "\n  Reading: every uncapped cell is ~97% (the curve is fair at all targets).\n" +
    "  The cap doesn't lower RTP — it caps the absolute win. Cells marked '·' are\n" +
    "  targets ABOVE the bet's effective max (e.g. >100x on a €100 bet), where a\n" +
    "  player would be capping their win yet taking more risk → sub-97%. Rational\n" +
    "  play (target ≤ effective max) keeps the full 97%. Effective max per bet:\n" +
    "  " + BET_SIZES_EUR.map((b) => `€${b}→${MAX_WIN_PER_BET_EUR / b}x`).join(", ") + ".",
);
console.log("\n===========================================================\n");
