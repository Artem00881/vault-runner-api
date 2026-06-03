import { test, expect, describe } from "bun:test";
import { resolveReservingStaleMs } from "../src/game/game.gateway";

/**
 * Unit guard for the 'reserving' sweep age threshold parse — a MONEY-SAFETY control.
 * The age gate stops the periodic sweep from refunding a placeBet still in flight, so a
 * misconfigured RESERVING_STALE_SEC must NEVER shrink or disable the gate: anything
 * non-finite, non-positive, or below the 30s floor falls back to the safe 120s default.
 *
 * Why this exists: a naive `Math.max(1, Number(x))` parse returns NaN for non-numeric
 * input, and the engine reads `NaN > 0` as false → "no age gate" → the sweep would
 * refund in-flight bets on live prod. This pins the defensive parse.
 */
describe("resolveReservingStaleMs", () => {
  test("unset → 120s default", () => {
    expect(resolveReservingStaleMs(undefined)).toBe(120_000);
  });

  test("a valid override is honoured", () => {
    expect(resolveReservingStaleMs("120")).toBe(120_000);
    expect(resolveReservingStaleMs("60")).toBe(60_000);
    expect(resolveReservingStaleMs("300")).toBe(300_000);
  });

  test("30s floor is inclusive; just below falls back to 120s", () => {
    expect(resolveReservingStaleMs("30")).toBe(30_000);
    expect(resolveReservingStaleMs("29")).toBe(120_000);
  });

  test("a dangerously-low value never shrinks the gate", () => {
    expect(resolveReservingStaleMs("5")).toBe(120_000);
    expect(resolveReservingStaleMs("1")).toBe(120_000);
  });

  test("non-numeric / NaN never disables the gate (the bug this fixes)", () => {
    expect(resolveReservingStaleMs("abc")).toBe(120_000);
    expect(resolveReservingStaleMs("")).toBe(120_000); // Number("") === 0 → below floor
    expect(resolveReservingStaleMs("12px")).toBe(120_000);
  });

  test("non-positive and non-finite fall back to 120s", () => {
    expect(resolveReservingStaleMs("0")).toBe(120_000);
    expect(resolveReservingStaleMs("-50")).toBe(120_000);
    expect(resolveReservingStaleMs("Infinity")).toBe(120_000);
  });
});
