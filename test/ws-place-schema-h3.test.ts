import { test, expect } from "bun:test";
import { placeSchema } from "../src/game/ws-schemas";

/**
 * Regression for audit H3 — the gateway `placeSchema` must reject Infinity / NaN.
 *
 * `z.number().positive()` ACCEPTS Infinity (and `.gt(1)` accepts Infinity too),
 * and NaN slips through some numeric refinements. A non-finite `amount` then
 * reached `BigInt(Math.floor(amount))` in BetsService and THREW before the bet
 * try-block, surfacing as an unhandled rejection in the WS handler instead of a
 * clean validation rejection.
 *
 * The fix is `.finite()` on `amount` and on the optional `autoCashout`. These
 * tests assert the actual exported production schema (imported, not copied) so it
 * can't silently drift. Pre-fix, the Infinity/NaN "invalid" rows below would have
 * PARSED successfully → this table would FAIL.
 *
 * No DB / NestJS needed: pure schema validation.
 */

// Valid payloads still parse.
const valid: Array<[string, unknown]> = [
  ["finite amount, panel A", { panel: "A", amount: 100 }],
  ["finite amount, panel B", { panel: "B", amount: 1 }],
  ["finite amount + finite autoCashout", { panel: "A", amount: 50, autoCashout: 2.5 }],
  ["fractional amount", { panel: "A", amount: 12.34 }],
];

// Invalid payloads must be rejected (the H3 cases + the existing guards).
const invalid: Array<[string, unknown]> = [
  ["Infinity amount", { panel: "A", amount: Infinity }],
  ["-Infinity amount", { panel: "A", amount: -Infinity }],
  ["NaN amount", { panel: "A", amount: NaN }],
  ["Infinity autoCashout", { panel: "A", amount: 100, autoCashout: Infinity }],
  ["NaN autoCashout", { panel: "A", amount: 100, autoCashout: NaN }],
  // pre-existing guards still hold:
  ["zero amount", { panel: "A", amount: 0 }],
  ["negative amount", { panel: "A", amount: -5 }],
  ["autoCashout not > 1", { panel: "A", amount: 100, autoCashout: 1 }],
  ["bad panel", { panel: "C", amount: 100 }],
  ["amount is a string", { panel: "A", amount: "100" }],
];

for (const [name, payload] of valid) {
  test(`H3 valid: ${name} parses`, () => {
    expect(placeSchema.safeParse(payload).success).toBe(true);
  });
}

for (const [name, payload] of invalid) {
  test(`H3 invalid: ${name} is rejected`, () => {
    expect(placeSchema.safeParse(payload).success).toBe(false);
  });
}

test("H3 focus: Infinity / NaN amount specifically fail (the headline H3 fix)", () => {
  expect(placeSchema.safeParse({ panel: "A", amount: Infinity }).success).toBe(false);
  expect(placeSchema.safeParse({ panel: "A", amount: NaN }).success).toBe(false);
  expect(placeSchema.safeParse({ panel: "B", amount: 100, autoCashout: Infinity }).success).toBe(false);
});
