import { test, expect, describe } from "bun:test";
import {
  validateRgConfig,
  parseRgConfig,
  effectiveRgFor,
  serializeRg,
  deserializeRg,
  type EffectiveRg,
} from "../src/operator/rg-config";

/**
 * Phase 3 — responsible-gambling config (pure; no DB). Mirrors bet-limits.test.ts.
 * Proves: write-time validation THROWS on bad config; defensive read returns null on
 * garbage; per-currency resolution is case-insensitive + inherited-key-safe + keeps
 * currency-agnostic time knobs; serialize/deserialize round-trips BigInt and is null-safe.
 */

describe("validateRgConfig (write-time, THROWS on invalid)", () => {
  test("accepts a full valid config", () => {
    const cfg = {
      realityCheckIntervalSec: 3600,
      maxSessionSec: 86400,
      enforceRealityCheck: true,
      limits: { EUR: { maxSessionLoss: 50000, maxSessionWager: 200000 } },
    };
    expect(validateRgConfig(cfg)).toEqual(cfg);
  });
  test("accepts time-only and per-currency-partial configs", () => {
    expect(() => validateRgConfig({ realityCheckIntervalSec: 3600 })).not.toThrow();
    expect(() => validateRgConfig({ limits: { EUR: { maxSessionWager: 100 } } })).not.toThrow();
    expect(() => validateRgConfig({})).not.toThrow(); // valid-empty (resolves to no RG)
  });
  test.each([
    ["interval below floor", { realityCheckIntervalSec: 30 }],
    ["interval above cap (24h)", { realityCheckIntervalSec: 90_000 }],
    ["negative interval", { realityCheckIntervalSec: -1 }],
    ["float interval", { realityCheckIntervalSec: 3.5 }],
    ["maxSessionSec below floor", { maxSessionSec: 10 }],
    ["maxSessionSec above cap (30d)", { maxSessionSec: 3_000_000 }],
    ["negative money cap", { limits: { EUR: { maxSessionLoss: -1 } } }],
    ["zero money cap", { limits: { EUR: { maxSessionWager: 0 } } }],
    ["float money cap", { limits: { EUR: { maxSessionLoss: 1.5 } } }],
    ["unknown top-level key (.strict)", { foo: 1 }],
    ["non-boolean enforce", { enforceRealityCheck: "yes" }],
    ["null root", null],
  ])("throws on %s", (_label, bad) => {
    expect(() => validateRgConfig(bad)).toThrow();
  });
});

describe("parseRgConfig (defensive read)", () => {
  test("returns the config for valid, null for garbage", () => {
    expect(parseRgConfig({ realityCheckIntervalSec: 3600 })).toEqual({ realityCheckIntervalSec: 3600 });
    for (const g of [null, undefined, "str", 123, [], { realityCheckIntervalSec: 5 }, { foo: 1 }]) {
      expect(parseRgConfig(g)).toBeNull();
    }
  });
});

describe("effectiveRgFor (resolution)", () => {
  const full = {
    realityCheckIntervalSec: 3600,
    maxSessionSec: 86400,
    limits: { EUR: { maxSessionLoss: 50000, maxSessionWager: 200000 } },
  };
  test("present currency → BigInt money + time knobs + enforce default true", () => {
    expect(effectiveRgFor(full, "EUR")).toEqual({
      realityCheckIntervalSec: 3600,
      maxSessionSec: 86400,
      enforceRealityCheck: true,
      maxSessionLoss: 50000n,
      maxSessionWager: 200000n,
    });
  });
  test("currency with no limits entry still gets the currency-agnostic time knobs", () => {
    expect(effectiveRgFor(full, "USDT")).toEqual({
      realityCheckIntervalSec: 3600,
      maxSessionSec: 86400,
      enforceRealityCheck: true,
    });
  });
  test("case-insensitive currency match (both directions)", () => {
    const cfg = { limits: { eur: { maxSessionLoss: 100 } } };
    expect(effectiveRgFor(cfg, "EUR")?.maxSessionLoss).toBe(100n);
    expect(effectiveRgFor({ limits: { EUR: { maxSessionLoss: 100 } } }, "eur")?.maxSessionLoss).toBe(100n);
  });
  test("inherited-key currency never throws and never matches", () => {
    for (const ccy of ["__proto__", "toString", "constructor", "hasOwnProperty"]) {
      expect(effectiveRgFor({ limits: { EUR: { maxSessionLoss: 1 } } }, ccy)).toBeNull();
    }
  });
  test("null/garbage config and no-active-control configs → null", () => {
    expect(effectiveRgFor(null, "EUR")).toBeNull();
    expect(effectiveRgFor("garbage", "EUR")).toBeNull();
    expect(effectiveRgFor({}, "EUR")).toBeNull(); // empty → no control
    expect(effectiveRgFor({ enforceRealityCheck: false }, "EUR")).toBeNull(); // enforce alone is not a control
    expect(effectiveRgFor({ limits: { USDT: { maxSessionLoss: 1 } } }, "EUR")).toBeNull(); // other-currency-only, no time knob
  });
  test("enforceRealityCheck:false is preserved", () => {
    expect(effectiveRgFor({ realityCheckIntervalSec: 3600, enforceRealityCheck: false }, "EUR")).toEqual({
      realityCheckIntervalSec: 3600,
      enforceRealityCheck: false,
    });
  });
});

describe("serializeRg / deserializeRg round-trip", () => {
  const cases: Array<[string, EffectiveRg]> = [
    ["full", { realityCheckIntervalSec: 3600, maxSessionSec: 86400, enforceRealityCheck: true, maxSessionLoss: 50000n, maxSessionWager: 200000n }],
    ["time-only enforce true", { realityCheckIntervalSec: 3600, enforceRealityCheck: true }],
    ["enforce false", { realityCheckIntervalSec: 3600, enforceRealityCheck: false }],
    ["money-only", { enforceRealityCheck: true, maxSessionLoss: 1n }],
    ["large bigint", { enforceRealityCheck: true, maxSessionWager: 9_999_999_999_999n }],
  ];
  test.each(cases)("round-trips %s (BigInt + JSON survivable)", (_label, eff) => {
    const s = serializeRg(eff);
    const viaJson = JSON.parse(JSON.stringify(s)); // the JWT-claim trip
    expect(deserializeRg(viaJson)).toEqual(eff);
  });
  test("deserializeRg returns null (never throws) on garbage", () => {
    for (const g of [
      null,
      undefined,
      "str",
      123,
      {}, // no active control
      { maxSessionLoss: "-5" }, // negative
      { maxSessionWager: "abc" }, // BigInt throws → null
      { realityCheckIntervalSec: -1 },
      { realityCheckIntervalSec: 1.5 },
      { realityCheckIntervalSec: 90_000 }, // above the 24h cap → fail-closed
      { maxSessionSec: 3_000_000 }, // above the 30d cap → fail-closed
      { maxSessionLoss: "0" }, // zero
    ]) {
      expect(deserializeRg(g)).toBeNull();
    }
  });
  test("deserializeRg defaults enforce true when absent", () => {
    expect(deserializeRg({ realityCheckIntervalSec: 3600 })).toEqual({
      realityCheckIntervalSec: 3600,
      enforceRealityCheck: true,
    });
  });
});
