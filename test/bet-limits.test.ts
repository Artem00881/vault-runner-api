import { test, expect, describe } from "bun:test";
import {
  validateBetLimits,
  parseBetLimits,
  effectiveLimitsFor,
} from "../src/operator/bet-limits";

/**
 * Phase 3, piece 1 — pure bet-limits config (no DB).
 *
 * `bet-limits.ts` is the single source of truth for an operator's per-currency,
 * per-bet knobs (min/max stake + single-bet win cap) stored on the untyped
 * `Operator.betLimits` JSON column. The invariants under test:
 *
 *  - shape {"<CCY>": {minBet, maxBet, maxWinPerBet}} of NON-NEGATIVE INTEGER
 *    minor units, with refinements maxBet >= minBet and maxWinPerBet >= maxBet;
 *  - validateBetLimits THROWS on anything invalid (WRITE-time guard — bad config
 *    never enters the DB);
 *  - parseBetLimits is DEFENSIVE — null on absent/garbage (a hand-edited bad row
 *    falls back to global defaults rather than crashing a bet);
 *  - effectiveLimitsFor returns BigInt minor units for a present currency, null
 *    for an absent one (caller then uses global env defaults).
 */

const GOOD = { EUR: { minBet: 10, maxBet: 10000, maxWinPerBet: 1000000 } };

describe("bet-limits: valid config", () => {
  test("a valid single-currency config parses and round-trips its values", () => {
    const cfg = validateBetLimits(GOOD);
    expect(cfg.EUR.minBet).toBe(10);
    expect(cfg.EUR.maxBet).toBe(10000);
    expect(cfg.EUR.maxWinPerBet).toBe(1000000);
    // parseBetLimits agrees with the strict validator on good input.
    expect(parseBetLimits(GOOD)).toEqual(cfg);
  });

  test("a multi-currency config parses every entry", () => {
    const multi = {
      EUR: { minBet: 10, maxBet: 10000, maxWinPerBet: 1000000 },
      USDT: { minBet: 1, maxBet: 5000, maxWinPerBet: 50000 },
    };
    const cfg = validateBetLimits(multi);
    expect(Object.keys(cfg).sort()).toEqual(["EUR", "USDT"]);
    expect(cfg.USDT.maxBet).toBe(5000);
  });

  test("boundary equalities are allowed: maxBet == minBet and maxWinPerBet == maxBet", () => {
    // The refinements are >= (not >), so the degenerate equal case is VALID.
    const edge = { EUR: { minBet: 100, maxBet: 100, maxWinPerBet: 100 } };
    expect(() => validateBetLimits(edge)).not.toThrow();
    const eff = effectiveLimitsFor(edge, "EUR")!;
    expect(eff.minBet).toBe(100n);
    expect(eff.maxBet).toBe(100n);
    expect(eff.maxWinPerBet).toBe(100n);
  });

  test("minBet may be zero (nonnegative), maxBet/maxWinPerBet must be positive", () => {
    const zeroMin = { EUR: { minBet: 0, maxBet: 10, maxWinPerBet: 10 } };
    expect(() => validateBetLimits(zeroMin)).not.toThrow();
    expect(effectiveLimitsFor(zeroMin, "EUR")!.minBet).toBe(0n);
  });
});

describe("bet-limits: effectiveLimitsFor → BigInt", () => {
  test("returns BigInt minor units for a present currency", () => {
    const eff = effectiveLimitsFor(GOOD, "EUR");
    expect(eff).not.toBeNull();
    expect(eff!.minBet).toBe(10n);
    expect(eff!.maxBet).toBe(10000n);
    expect(eff!.maxWinPerBet).toBe(1000000n);
    // genuinely BigInt, not number.
    expect(typeof eff!.minBet).toBe("bigint");
  });

  test("returns null for a currency absent from the config", () => {
    expect(effectiveLimitsFor(GOOD, "USD")).toBeNull();
  });

  test("returns null (never throws) for inherited Object.prototype keys", () => {
    // 'currency' is operator-controlled; a key like "toString"/"constructor"/
    // "__proto__" must NOT resolve to an inherited member and then throw in BigInt().
    for (const k of ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"]) {
      expect(effectiveLimitsFor(GOOD, k)).toBeNull();
    }
  });

  test("is case-INSENSITIVE on the currency key (legacy/lowercase keys still resolve)", () => {
    // Phase 3.2: a lowercase query OR a lowercase config key must still resolve —
    // otherwise an operator's per-currency limit silently fails open to the global cap.
    expect(effectiveLimitsFor(GOOD, "eur")).not.toBeNull();
    expect(effectiveLimitsFor(GOOD, "eur")!.maxBet).toBe(10000n);
    // lowercase CONFIG key resolves for an uppercase query too.
    expect(effectiveLimitsFor({ eur: { minBet: 1, maxBet: 9, maxWinPerBet: 9 } }, "EUR")!.maxBet).toBe(9n);
  });

  test("returns null when the whole config is null/garbage (falls back to defaults)", () => {
    expect(effectiveLimitsFor(null, "EUR")).toBeNull();
    expect(effectiveLimitsFor(undefined, "EUR")).toBeNull();
    expect(effectiveLimitsFor("not-json", "EUR")).toBeNull();
    // a row valid for OTHER currencies but invalid overall → whole config rejected.
    expect(effectiveLimitsFor({ EUR: { minBet: -1, maxBet: 10, maxWinPerBet: 10 } }, "EUR")).toBeNull();
  });
});

describe("bet-limits: parseBetLimits is defensive (null, never throws)", () => {
  // Table-driven garbage — each must yield null, not throw.
  const garbage: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a bare string", "nope"],
    ["a number", 123],
    ["a bare array", [{ minBet: 1, maxBet: 2, maxWinPerBet: 3 }]],
    ["missing maxWinPerBet", { EUR: { minBet: 1, maxBet: 2 } }],
    ["non-integer minBet", { EUR: { minBet: 1.5, maxBet: 2, maxWinPerBet: 3 } }],
    ["negative minBet", { EUR: { minBet: -1, maxBet: 2, maxWinPerBet: 3 } }],
    ["maxBet < minBet", { EUR: { minBet: 100, maxBet: 10, maxWinPerBet: 1000 } }],
    ["maxWinPerBet < maxBet", { EUR: { minBet: 1, maxBet: 100, maxWinPerBet: 50 } }],
    ["empty currency key", { "": { minBet: 1, maxBet: 2, maxWinPerBet: 3 } }],
    ["string amounts", { EUR: { minBet: "1", maxBet: "2", maxWinPerBet: "3" } }],
  ];
  for (const [label, input] of garbage) {
    test(`parseBetLimits returns null for ${label}`, () => {
      expect(parseBetLimits(input)).toBeNull();
    });
  }

  test("an empty object {} is a valid (no-currency) config, not garbage", () => {
    // record(...) of zero entries is structurally valid; it just has no currency.
    expect(parseBetLimits({})).toEqual({});
    expect(effectiveLimitsFor({}, "EUR")).toBeNull();
  });
});

describe("bet-limits: validateBetLimits THROWS at write time", () => {
  // Table-driven invalid configs — the WRITE-time guard must throw on each.
  const invalid: Array<[string, unknown]> = [
    ["minBet < 0", { EUR: { minBet: -1, maxBet: 100, maxWinPerBet: 1000 } }],
    ["maxBet < minBet", { EUR: { minBet: 100, maxBet: 10, maxWinPerBet: 1000 } }],
    ["maxWinPerBet < maxBet", { EUR: { minBet: 1, maxBet: 100, maxWinPerBet: 50 } }],
    ["non-integer maxBet", { EUR: { minBet: 1, maxBet: 100.25, maxWinPerBet: 1000 } }],
    ["negative maxWinPerBet", { EUR: { minBet: 1, maxBet: 100, maxWinPerBet: -1000 } }],
    ["maxBet zero (not positive)", { EUR: { minBet: 0, maxBet: 0, maxWinPerBet: 0 } }],
    ["missing field", { EUR: { minBet: 1, maxBet: 100 } }],
    ["null", null],
    ["a string", "garbage"],
  ];
  for (const [label, input] of invalid) {
    test(`validateBetLimits throws on ${label}`, () => {
      expect(() => validateBetLimits(input)).toThrow();
    });
  }

  test("validateBetLimits returns the parsed config on valid input", () => {
    expect(validateBetLimits(GOOD)).toEqual(GOOD);
  });
});
