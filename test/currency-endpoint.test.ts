import { test, expect, describe } from "bun:test";
import { CurrencyController } from "../src/common/currency.controller";
import { listCurrencies } from "../src/common/currency";

/**
 * Phase 3.6 — public /api/currencies discovery (controller unit; no DB, no auth, no
 * Nest bootstrap). The controller is a thin wrapper over listCurrencies(), so we
 * construct it directly and assert the response SHAPE the embedding client relies on:
 * { currencies: [...] } with every row carrying its real decimals, sorted by code.
 */

describe("CurrencyController.list()", () => {
  test("returns { currencies: [...] } sorted by code", () => {
    const res = new CurrencyController().list();
    expect(res).toHaveProperty("currencies");
    expect(Array.isArray(res.currencies)).toBe(true);
    const codes = res.currencies.map((c) => c.code);
    expect(codes).toEqual([...codes].sort((a, b) => a.localeCompare(b)));
  });

  test("carries the real per-currency precision (BTC=8, USDT=6, JPY=0, ETH=18, EUR=2)", () => {
    const res = new CurrencyController().list();
    const byCode = new Map(res.currencies.map((c) => [c.code, c]));
    expect(byCode.get("BTC")).toMatchObject({ code: "BTC", decimals: 8 });
    expect(byCode.get("USDT")).toMatchObject({ code: "USDT", decimals: 6 });
    expect(byCode.get("JPY")).toMatchObject({ code: "JPY", decimals: 0 });
    expect(byCode.get("ETH")).toMatchObject({ code: "ETH", decimals: 18 });
    expect(byCode.get("EUR")).toMatchObject({ code: "EUR", decimals: 2 });
  });

  test("the payload is exactly listCurrencies() (no auth/filtering/widening)", () => {
    const res = new CurrencyController().list();
    expect(res.currencies).toEqual(listCurrencies());
  });

  test("every row has a numeric decimals and a non-empty code", () => {
    for (const c of new CurrencyController().list().currencies) {
      expect(typeof c.code).toBe("string");
      expect(c.code.length).toBeGreaterThan(0);
      expect(typeof c.decimals).toBe("number");
      expect(Number.isInteger(c.decimals)).toBe(true);
    }
  });
});
