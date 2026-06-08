import { test, expect, describe } from "bun:test";
import { floorPayout } from "../src/common/money";

/**
 * F-001 REGRESSION LOCK (money-creation fix, USER-signed-off H1, 2026-06-08).
 *
 * `cashOut` + auto-cashout both compute payout via floorPayout(stakeMinor, mult).
 * The OLD code was `BigInt(Math.floor(Number(stake) * mult))`, which round-tripped
 * the BigInt stake through an IEEE-754 double. That double path had TWO defects:
 *
 *   (a) MONEY CREATION for stakes ≥ 2^53 minor units (any high-decimal currency —
 *       2^53 wei ≈ 0.009 ETH): once Number(stake) loses precision, the product can
 *       land ABOVE the exact stake×mult, so the house pays out money that was never
 *       wagered. floorPayout never exceeds the exact integer floor.
 *   (b) OFF-BY-ONE toward the house on ~1% of small 2-dp multipliers: 100 × 1.14
 *       floats to 113.999… → Math.floor → 113, shorting the player by 1 unit.
 *       floorPayout returns the true 114.
 *
 * This file is a PURE unit test of floorPayout — no DB / engine / socket — so it is
 * fast and deterministic. The whole point is to assert at HIGH decimal places, where
 * the existing suite (which only checks clean 2.0/1.5 multipliers, old==new) is blind.
 *
 * The reference oracle is the SAME exact-BigInt formula the helper documents:
 *   (stake * BigInt(Math.round(mult * 100))) / 100n
 * computed independently here so a future "optimisation" of the helper that drifts
 * back toward a float can never silently pass.
 */

// Independent pure-BigInt reference (no Number() touches the stake).
function exactFloorRef(stake: bigint, mult: number): bigint {
  return (stake * BigInt(Math.round(mult * 100))) / 100n;
}

// The OLD buggy implementation, reconstructed verbatim, so we can PROVE this test
// would have failed on it (and that the contrast is real, not asserted blind).
function oldFloatPayout(stake: bigint, mult: number): bigint {
  return BigInt(Math.floor(Number(stake) * mult));
}

// Deterministic 2-dp multiplier generator — mulberry32 PRNG. The env forbids
// Math.random in tests (non-deterministic); this is seeded so every run is identical.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fixed-multiplier corners spanning clean, common, and extreme cash-out targets.
const FIXED_MULTS = [1.0, 1.14, 2.05, 3.27, 99.99, 1000000.0];

// A seeded spread of 2-dp multipliers in [1.00, 1000.00]. Deterministic.
const rngMults: number[] = (() => {
  const rng = mulberry32(0xf001); // seed = "F001"
  const out: number[] = [];
  for (let i = 0; i < 24; i++) {
    // 1.00 .. 1000.00, quantized to 2 dp (the live Decimal(10,2) contract).
    out.push(Math.round((1 + rng() * 999) * 100) / 100);
  }
  return out;
})();

const ALL_MULTS = [...FIXED_MULTS, ...rngMults];

// Stakes that straddle the 2^53 safe-integer boundary and reach into wei (1e18).
const STAKES: { label: string; v: bigint }[] = [
  { label: "1 minor unit", v: 1n },
  { label: "100 minor units (the off-by-one canary stake)", v: 100n },
  { label: "2^53 - 1 (last exactly-representable double)", v: 2n ** 53n - 1n },
  { label: "2^53 (first lossy double)", v: 2n ** 53n },
  { label: "2^53 + 1 (Number() collapses to 2^53)", v: 2n ** 53n + 1n },
  { label: "1e18 (1 ETH in wei)", v: 10n ** 18n },
  { label: "9007199254740993 (2^53 + 1 spelled out)", v: 9007199254740993n },
];

describe("F-001 floorPayout — exact integer floor across the 2^53 / wei boundary", () => {
  // (1) Exhaustive stake × mult grid vs the independent pure-BigInt reference.
  for (const { label, v } of STAKES) {
    for (const mult of ALL_MULTS) {
      test(`floor(${label} × ${mult}) == pure-BigInt reference`, () => {
        expect(floorPayout(v, mult)).toBe(exactFloorRef(v, mult));
      });
    }
  }
});

describe("F-001 floorPayout — the off-by-one fix is LOCKED IN", () => {
  // (2) The headline small-stake regression. 100 × 1.14:
  //   exact:  100 * 114 / 100 = 114
  //   OLD:    BigInt(Math.floor(Number(100) * 1.14)) = BigInt(Math.floor(113.999…)) = 113n
  // 113n was the OLD BUGGY value (shorted the player 1 unit toward the house). If this
  // assertion ever sees 113n again, the float path has silently returned.
  test("100 × 1.14 === 114n (old float path gave 113n — must never silently return)", () => {
    expect(floorPayout(100n, 1.14)).toBe(114n);
    expect(floorPayout(100n, 1.14)).not.toBe(113n); // 113n = the documented OLD bug

    // Prove the contrast is real: the reconstructed old impl actually produced 113.
    expect(oldFloatPayout(100n, 1.14)).toBe(113n);
  });
});

describe("F-001 floorPayout — MONEY-CREATION guard (the headline)", () => {
  // (3) High-dp stake at a non-clean multiplier. The old Number() path OVER-paid here
  // (created money that was never wagered); floorPayout must (a) never exceed the exact
  // stake×mult, and (b) equal the exact BigInt floor.
  const stake = 2n ** 53n + 7n; // beyond the exactly-representable range of a double
  const mult = 1.14; // non-clean: 1.14 has no exact binary fraction

  test("never exceeds exact stake×mult AND equals the exact BigInt floor", () => {
    const got = floorPayout(stake, mult);
    const multCents = BigInt(Math.round(mult * 100)); // 114n

    // (a) NEVER creates money: floored payout ≤ the exact (un-floored) stake×mult.
    //     Compare in a common scale (×100) to stay in exact BigInt.
    expect(got * 100n).toBeLessThanOrEqual(stake * multCents);

    // (b) equals the exact integer floor.
    expect(got).toBe((stake * multCents) / 100n);

    // CONTRAST: the OLD float path returns a DIFFERENT (over-paid) value here, because
    // Number(2^53 + 7) rounds up and Number(2^53+7)*1.14 lands above the true product.
    const oldVal = oldFloatPayout(stake, mult); // BigInt(Math.floor(Number(stake)*mult))
    expect(got).not.toBe(oldVal);
    // and the old value is STRICTLY GREATER than the exact floor — i.e. it minted money.
    expect(oldVal).toBeGreaterThan(got);
  });

  // Generalise the no-mint invariant across the whole grid: for EVERY stake×mult the
  // floored payout, scaled back up by 100, never exceeds the exact stake×multCents.
  test("no-mint invariant holds for the entire stake × mult grid", () => {
    for (const { v } of STAKES) {
      for (const mult of ALL_MULTS) {
        const multCents = BigInt(Math.round(mult * 100));
        expect(floorPayout(v, mult) * 100n).toBeLessThanOrEqual(v * multCents);
      }
    }
  });
});

describe("F-001 floorPayout — edges", () => {
  // (4a) ×1.00 is an exact identity, even on a 20-digit stake (well past 1e18 wei).
  test("× 1.00 returns the stake exactly (20-digit stake)", () => {
    const big = 12345678901234567890n; // 20 digits
    expect(floorPayout(big, 1.0)).toBe(big);
    expect(floorPayout(1n, 1.0)).toBe(1n);
    expect(floorPayout(2n ** 53n + 1n, 1.0)).toBe(2n ** 53n + 1n);
  });

  // (4b) Monotonic non-decreasing in stake at a fixed multiplier.
  test("monotonic non-decreasing in stake", () => {
    const mult = 3.27;
    const sorted = [...STAKES].map((s) => s.v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < sorted.length; i++) {
      expect(floorPayout(sorted[i], mult)).toBeGreaterThanOrEqual(floorPayout(sorted[i - 1], mult));
    }
  });

  // (4c) Never negative for non-negative inputs (the live contract: stake ≥ 0, mult ≥ 1).
  test("never negative across the grid", () => {
    for (const { v } of STAKES) {
      for (const mult of ALL_MULTS) {
        expect(floorPayout(v, mult)).toBeGreaterThanOrEqual(0n);
      }
    }
  });
});
