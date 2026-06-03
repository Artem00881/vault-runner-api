import { test, expect, afterEach } from "bun:test";
import { UnauthorizedException } from "@nestjs/common";
import { MetricsAuthGuard } from "../src/metrics/metrics-auth.guard";
import { safeTokenEqual, bearerToken } from "../src/common/timing-safe";

// METRICS_TOKEN is read from process.env at call time, and the bun test process
// is SHARED across files. Restore whatever was there after every test so this
// suite can never leak a token into another file (audit H5 env hygiene).
const SAVED = process.env.METRICS_TOKEN;
afterEach(() => {
  if (SAVED === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = SAVED;
});

// Fake ExecutionContext exposing exactly what the guard touches:
//   ctx.switchToHttp().getRequest().headers.authorization
function ctxWith(authorization?: string): any {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
  };
}

// ── MetricsAuthGuard ────────────────────────────────────────────────────────

test("guard: METRICS_TOKEN unset → open (true) regardless of header", () => {
  delete process.env.METRICS_TOKEN;
  const g = new MetricsAuthGuard();
  expect(g.canActivate(ctxWith(undefined))).toBe(true);
  expect(g.canActivate(ctxWith("Bearer anything"))).toBe(true);
  expect(g.canActivate(ctxWith("garbage"))).toBe(true);
});

test("guard: METRICS_TOKEN set + correct Bearer token → true", () => {
  process.env.METRICS_TOKEN = "s3cr3t-token";
  const g = new MetricsAuthGuard();
  expect(g.canActivate(ctxWith("Bearer s3cr3t-token"))).toBe(true);
});

// Table-driven: every non-matching header shape must be rejected.
const rejectCases: Array<[string, string | undefined]> = [
  ["missing header", undefined],
  ["wrong token", "Bearer wrong-token"],
  ["non-Bearer scheme", "Basic s3cr3t-token"],
  ["raw token, no scheme", "s3cr3t-token"],
  ["empty string", ""],
  ["Bearer with empty token", "Bearer "],
  ["correct token but lower-case bearer", "bearer s3cr3t-token"],
];

for (const [name, authorization] of rejectCases) {
  test(`guard: METRICS_TOKEN set + ${name} → throws UnauthorizedException`, () => {
    process.env.METRICS_TOKEN = "s3cr3t-token";
    const g = new MetricsAuthGuard();
    expect(() => g.canActivate(ctxWith(authorization))).toThrow(UnauthorizedException);
  });
}

// ── safeTokenEqual ──────────────────────────────────────────────────────────

test("safeTokenEqual: identical strings → true", () => {
  expect(safeTokenEqual("abc123", "abc123")).toBe(true);
});

test("safeTokenEqual: different / length-mismatch / empty / nullish → false", () => {
  expect(safeTokenEqual("abc123", "abc124")).toBe(false); // same length, different
  expect(safeTokenEqual("abc", "abcdef")).toBe(false);    // length mismatch (must not throw)
  expect(safeTokenEqual("", "")).toBe(false);             // both empty
  expect(safeTokenEqual("", "abc")).toBe(false);
  expect(safeTokenEqual("abc", "")).toBe(false);
  expect(safeTokenEqual(undefined, "abc")).toBe(false);
  expect(safeTokenEqual("abc", undefined)).toBe(false);
  expect(safeTokenEqual(null, null)).toBe(false);
});

// ── bearerToken ─────────────────────────────────────────────────────────────

test("bearerToken: extracts token only from a well-formed Bearer header", () => {
  expect(bearerToken("Bearer abc123")).toBe("abc123");
  expect(bearerToken("Basic abc123")).toBeUndefined();
  expect(bearerToken("abc123")).toBeUndefined();
  expect(bearerToken(undefined)).toBeUndefined();
  expect(bearerToken(null)).toBeUndefined();
  expect(bearerToken("")).toBeUndefined();
});
