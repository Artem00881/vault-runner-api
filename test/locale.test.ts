import { test, expect, describe } from "bun:test";
import { normalizeLocale } from "../src/common/locale";

/**
 * Phase 3.6 — lenient BCP-47 locale normalization (pure; no DB). `locale` is an
 * operator-controlled COSMETIC pass-through (launch token → GameSession.locale → play
 * token + launch response), so the contract is: normalize casing (lang lowercase,
 * 2-letter region UPPERCASE, script/numeric subtags left as-is), and reject anything
 * malformed to "en" WITHOUT EVER THROWING — a bad locale must never 401 a launch nor
 * let "'; DROP" / a 5 KB blob reach the DB or a token claim.
 */

describe("L.1 well-formed locales normalize casing", () => {
  test.each([
    ["en", "en"],
    ["EN", "en"], // language → lowercase
    ["en-US", "en-US"],
    ["en-us", "en-US"], // region → UPPERCASE
    ["EN-us", "en-US"], // both fixed
    ["EN-US", "en-US"],
    ["pt-BR", "pt-BR"],
    ["pt-br", "pt-BR"],
    ["es-419", "es-419"], // numeric region subtag left as-is
    ["ES-419", "es-419"],
    ["fr", "fr"],
    ["de-CH", "de-CH"],
    ["zh-Hans-CN", "zh-Hans-CN"], // script subtag (4 letters) untouched, region upper
    ["zh-hans-cn", "zh-hans-CN"], // 4-letter subtag not a 2-letter region → left as-is; final cn→CN
    ["yue", "yue"], // 3-letter language
  ])("%s → %s", (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected);
  });

  test("surrounding whitespace is trimmed before validation", () => {
    expect(normalizeLocale("  en-US  ")).toBe("en-US");
    expect(normalizeLocale("\ten-gb\n")).toBe("en-GB");
  });
});

describe("L.2 garbage → \"en\", NEVER throws (must-pass invariant)", () => {
  test.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["SQL-ish injection", "'; DROP TABLE users; --"],
    ["single-letter lang (too short)", "e"],
    ["4-letter lang (too long)", "engl"],
    ["leading hyphen", "-en"],
    ["trailing hyphen", "en-"],
    ["double hyphen", "en--US"],
    ["too many subtags", "en-US-x-extra-more"],
    ["underscore separator", "en_US"],
    ["a subtag with symbols", "en-U$"],
    ["a 9-char subtag (over the 8 cap)", "en-ABCDEFGHI"],
    ["spaces inside", "en US"],
    ["a 5 KB blob", "a".repeat(5000)],
    ["null", null],
    ["undefined", undefined],
    ["a number", 123],
    ["a boolean", true],
    ["an object", {}],
    ["an array", ["en-US"]],
    ["the string \"toString\"", "toString"], // 8 letters, no hyphen → fails the regex → "en"
  ])("%s → \"en\"", (_label, input) => {
    let out = "";
    expect(() => {
      out = normalizeLocale(input);
    }).not.toThrow();
    expect(out).toBe("en");
  });

  test("output is ALWAYS a non-empty string (no path returns undefined/null)", () => {
    for (const g of [null, undefined, "", "garbage!!!", 5, {}, [], "en-US", "PT-br"]) {
      const out = normalizeLocale(g as unknown);
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
