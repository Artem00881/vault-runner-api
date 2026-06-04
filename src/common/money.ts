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
