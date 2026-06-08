/**
 * Money serialization helpers for reporting/aggregation responses.
 *
 * Per-row endpoints (wallet balance, a single bet) emit `Number(bigint)` — safe
 * because a single balance is well under 2^53. But AGGREGATES (an operator's total
 * turnover across many bets) can exceed Number.MAX_SAFE_INTEGER, so reporting emits
 * money as DECIMAL STRINGS of BigInt minor units. Do NOT "normalise" these to
 * Number — that would silently truncate large sums. (Phase 3.5)
 */

/** A BigInt amount of minor units as an exact decimal string (sign preserved). */
export function minorUnitsToString(v: bigint): string {
  return v.toString();
}

/**
 * RTP = won / wagered as an exact, float-free decimal string with 4 dp (floor).
 * Returns "0" when nothing was wagered (no divide-by-zero). Can exceed 1.0 over a
 * lucky period (won > wagered). Inputs are non-negative minor-unit sums.
 */
export function rtpRatioString(won: bigint, wagered: bigint): string {
  if (wagered <= 0n) return "0";
  const scaled = (won * 10000n) / wagered; // 4 dp, floored
  const intPart = scaled / 10000n;
  const frac = (scaled % 10000n).toString().padStart(4, "0");
  return `${intPart}.${frac}`;
}

/**
 * Exact integer floor of `stake × mult`, where `stakeMinor` is BigInt minor units and
 * `mult` is a 2-decimal-place multiplier. Pure + float-free on the stake (F-001).
 *
 * The old `BigInt(Math.floor(Number(stake) * mult))` round-tripped the BigInt stake
 * through an IEEE-754 double and (a) CREATED money for stakes ≥ 2^53 minor units (any
 * high-decimal currency — 2^53 wei ≈ 0.009 ETH), and (b) even for small 2-dp stakes
 * shorted the player by 1 unit on ~1% of multipliers (e.g. `100 × 1.14` floats to
 * `113.999…` → floors to 113 instead of the true 114). `Math.round(mult*100)` absorbs
 * that representation error (1.14→114); the BigInt divide by 100n does the floor
 * (truncation toward zero == floor for non-negative operands, which both always are).
 *
 * CONTRACT: `mult` MUST be ≤ 2 dp (the live `crashPoint` / `cashoutMult` / `autoCashout`
 * are all `Decimal(10,2)`). A >2-dp `mult` is silently re-quantized to 2 dp by the round.
 */
export function floorPayout(stakeMinor: bigint, mult: number): bigint {
  const multCents = BigInt(Math.round(mult * 100));
  return (stakeMinor * multCents) / 100n;
}
