import { test, expect, describe } from "bun:test";
import {
  currencyMeta,
  isKnownCurrency,
  listCurrencies,
  CURRENCIES,
  CurrencyMetaSchema,
} from "../src/common/currency";

/**
 * Phase 3.6 — canonical per-currency PRECISION table (pure; no DB). currencyMeta is
 * DISPLAY metadata only (no money math reads it — minor units stay exact), but it is
 * a launch/report hot path, so the invariants here are: the non-2-decimal canaries are
 * REAL (JPY=0/USDT=6/BTC=8/ETH=18, not "always 2"); resolution is case-insensitive;
 * it is PROTOTYPE-POLLUTION-safe (a "currency" of __proto__/toString/constructor can
 * never hit an inherited Object member — Map-backed, same posture as effectiveLimitsFor);
 * unknown/null/garbage → { decimals: 2, known: false } and NEVER throws; and the seed
 * table itself is internally valid (schema-clean, no dup codes, sorted discovery list).
 */

// The canonical seed precisions we assert against. The non-2 entries are the canaries.
const SEED_DECIMALS: Record<string, number> = {
  DEMO: 2,
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
  CAD: 2,
  AUD: 2,
  BRL: 2,
  INR: 2,
  JPY: 0, // canary: real 0-dp
  USDT: 6, // canary
  USDC: 6, // canary
  BTC: 8, // canary
  ETH: 18, // canary (the max the schema allows)
};

describe("C.1 currencyMeta — seed decimals (canaries prove it's not always-2)", () => {
  test.each(Object.entries(SEED_DECIMALS))("%s → decimals %d, known:true", (code, decimals) => {
    const m = currencyMeta(code);
    expect(m.code).toBe(code);
    expect(m.decimals).toBe(decimals);
    expect(m.known).toBe(true);
  });

  test("the non-2 canaries are distinct (the table carries real per-currency precision)", () => {
    expect(currencyMeta("JPY").decimals).toBe(0);
    expect(currencyMeta("USDT").decimals).toBe(6);
    expect(currencyMeta("BTC").decimals).toBe(8);
    expect(currencyMeta("ETH").decimals).toBe(18);
    expect(currencyMeta("EUR").decimals).toBe(2);
    // Not all the same value → proves it is not a constant.
    const set = new Set([0, 6, 8, 18, 2]);
    expect(set.size).toBe(5);
  });
});

describe("C.2 case-insensitivity", () => {
  test("lower/mixed case resolve identically to upper and stay known", () => {
    expect(currencyMeta("eur")).toEqual(currencyMeta("EUR"));
    expect(currencyMeta("eur").known).toBe(true);
    expect(currencyMeta("Eur").decimals).toBe(2);
    expect(currencyMeta("usdt").decimals).toBe(6);
    expect(currencyMeta("usdt").known).toBe(true);
    expect(currencyMeta("bTc").decimals).toBe(8);
    // The resolved code is canonical UPPERCASE regardless of input casing.
    expect(currencyMeta("eur").code).toBe("EUR");
    expect(currencyMeta("eth").code).toBe("ETH");
  });
});

describe("C.3 prototype-pollution safety (must-pass invariant)", () => {
  test.each(["__proto__", "toString", "constructor", "hasOwnProperty", "valueOf", "isPrototypeOf"])(
    "%s → { known:false, decimals:2 }, never throws, never an inherited member",
    (poison) => {
      let m: ReturnType<typeof currencyMeta>;
      expect(() => {
        m = currencyMeta(poison);
      }).not.toThrow();
      // The poison string never resolves to a real (inherited) Map/Object member —
      // it falls through to the unknown branch.
      expect(m!.known).toBe(false);
      expect(m!.decimals).toBe(2);
      // decimals must be a plain number (not a function bled through from the prototype).
      expect(typeof m!.decimals).toBe("number");
      // isKnownCurrency is the provisioning guard — it too must be poison-safe.
      expect(isKnownCurrency(poison)).toBe(false);
    },
  );

  test("uppercased prototype keys are equally safe (the lookup uppercases first)", () => {
    for (const poison of ["__PROTO__", "TOSTRING", "CONSTRUCTOR"]) {
      expect(currencyMeta(poison).known).toBe(false);
      expect(currencyMeta(poison).decimals).toBe(2);
    }
  });
});

describe("C.4 unknown / null / garbage → safe 2-dp fallback, never throws", () => {
  test("an unseeded but well-formed code → decimals:2, known:false, echoed UPPERCASE", () => {
    const m = currencyMeta("XYZ");
    expect(m).toEqual({ code: "XYZ", decimals: 2, known: false });
    expect(currencyMeta("xyz")).toEqual({ code: "XYZ", decimals: 2, known: false });
  });

  // The declared input type is `string | null | undefined`, and these are the in-contract
  // values — all currently safe.
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace", "   "],
    ["a very long blob", "Z".repeat(5000)],
  ])("%s → { known:false, decimals:2 }, no throw", (_label, input) => {
    let m: ReturnType<typeof currencyMeta>;
    expect(() => {
      m = currencyMeta(input as string | null | undefined);
    }).not.toThrow();
    expect(m!.known).toBe(false);
    expect(m!.decimals).toBe(2);
    expect(typeof m!.code).toBe("string");
  });

  // Defense-in-depth: currencyMeta's contract is "never throws". It uses
  // `String(code ?? "")` (not `?? ""`), so a NON-NULLISH non-string (number/object/
  // array/boolean) is coerced to a string that simply misses the Map → safe fallback,
  // rather than throwing TypeError on .toUpperCase(). (Was a latent bug; fixed in 3.6.)
  test.each([
    ["a number (non-string)", 123],
    ["an object (non-string)", {}],
    ["an array (non-string)", []],
    ["a boolean (non-string)", true],
  ])("%s → { known:false, decimals:2 }, no throw", (_label, input) => {
    let m: ReturnType<typeof currencyMeta>;
    expect(() => {
      m = currencyMeta(input as unknown as string | null | undefined);
    }).not.toThrow();
    expect(m!.known).toBe(false);
    expect(m!.decimals).toBe(2);
    expect(typeof m!.code).toBe("string");
  });
});

describe("C.5 isKnownCurrency", () => {
  test("true for seeded (any case), false for unseeded/garbage", () => {
    expect(isKnownCurrency("EUR")).toBe(true);
    expect(isKnownCurrency("eur")).toBe(true);
    expect(isKnownCurrency("JPY")).toBe(true);
    expect(isKnownCurrency("eth")).toBe(true);
    expect(isKnownCurrency("XYZ")).toBe(false);
    expect(isKnownCurrency("")).toBe(false);
    expect(isKnownCurrency(null)).toBe(false);
    expect(isKnownCurrency(undefined)).toBe(false);
  });
});

describe("C.6 listCurrencies — sorted, no dups, complete", () => {
  test("is sorted by code ascending", () => {
    const codes = listCurrencies().map((c) => c.code);
    const sorted = [...codes].sort((a, b) => a.localeCompare(b));
    expect(codes).toEqual(sorted);
  });

  test("has no duplicate codes", () => {
    const codes = listCurrencies().map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("contains every seeded currency with the right decimals", () => {
    const byCode = new Map(listCurrencies().map((c) => [c.code, c]));
    for (const [code, decimals] of Object.entries(SEED_DECIMALS)) {
      expect(byCode.get(code)?.decimals).toBe(decimals);
    }
    expect(byCode.size).toBe(Object.keys(SEED_DECIMALS).length);
  });

  test("returns a fresh array (sorting it does not mutate the canonical table order)", () => {
    const a = listCurrencies();
    a.sort((x, y) => y.code.localeCompare(x.code)); // reverse-sort the returned copy
    // A second call is still ascending → the internal table was not mutated.
    const b = listCurrencies().map((c) => c.code);
    expect(b).toEqual([...b].sort((x, y) => x.localeCompare(y)));
  });

  test("returns DEEP copies — mutating a row cannot poison the canonical table", () => {
    const a = listCurrencies();
    const eur = a.find((c) => c.code === "EUR")!;
    eur.decimals = 999; // attempt to corrupt the source of truth via a returned row
    expect(currencyMeta("EUR").decimals).toBe(2); // unaffected
    expect(listCurrencies().find((c) => c.code === "EUR")!.decimals).toBe(2);
  });
});

describe("C.7 CURRENCIES table integrity (schema-clean, deduped)", () => {
  test("every row passes CurrencyMetaSchema (code regex + 0..18 int decimals)", () => {
    for (const c of CURRENCIES) {
      expect(() => CurrencyMetaSchema.parse(c)).not.toThrow();
    }
  });

  test("codes are unique and canonical UPPERCASE/alnum", () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[A-Z0-9]{1,16}$/);
  });

  test("decimals are within the schema bound for every row", () => {
    for (const c of CURRENCIES) {
      expect(Number.isInteger(c.decimals)).toBe(true);
      expect(c.decimals).toBeGreaterThanOrEqual(0);
      expect(c.decimals).toBeLessThanOrEqual(18);
    }
  });
});
