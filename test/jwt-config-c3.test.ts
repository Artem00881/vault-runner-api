import { test, expect } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import { buildJwtOptions } from "../src/auth/auth.module";

/**
 * Regression for audit C3 — the JWT config must FAIL CLOSED on a missing secret.
 *
 * The old factory was `secret: config.get("JWT_SECRET") ?? "dev-secret"`: if
 * JWT_SECRET was ever unset/empty, every token was signed/verified with a known
 * string and anyone could mint a token for any `sub`. The fix throws when the
 * secret is missing/empty, warns when it's weak (<32 chars), and pins HS256.
 *
 * We exercise the real exported `buildJwtOptions` with a tiny fake ConfigService.
 * Pre-fix, the "missing"/"empty" cases below would have returned options with the
 * "dev-secret" fallback instead of throwing → these assertions would FAIL.
 *
 * No DB / no NestJS container needed.
 */

// Minimal ConfigService stand-in: only `.get(key)` is used by buildJwtOptions.
function fakeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

test("C3: missing JWT_SECRET throws (no insecure default)", () => {
  expect(() => buildJwtOptions(fakeConfig({}))).toThrow(/JWT_SECRET is required/);
});

test("C3: empty JWT_SECRET throws", () => {
  expect(() => buildJwtOptions(fakeConfig({ JWT_SECRET: "" }))).toThrow(/JWT_SECRET is required/);
});

test("C3: a set JWT_SECRET boots fine and pins HS256", () => {
  const strong = "a".repeat(48); // long, random-length secret
  const opts = buildJwtOptions(fakeConfig({ JWT_SECRET: strong })) as any;
  expect(opts.secret).toBe(strong);
  // Never the burned hardcoded default.
  expect(opts.secret).not.toBe("dev-secret");
  // Algorithm pinned both ways (defends against alg confusion).
  expect(opts.signOptions.algorithm).toBe("HS256");
  expect(opts.verifyOptions.algorithms).toEqual(["HS256"]);
  expect(opts.signOptions.expiresIn).toBe("30d");
});

test("C3: a short secret still boots (it's a warning, not fatal) but is honored", () => {
  // Weak secrets are a warn-not-throw: the game still runs in dev, but the value
  // used is exactly what was provided — never the dev-secret fallback.
  const weak = "short-secret";
  const opts = buildJwtOptions(fakeConfig({ JWT_SECRET: weak })) as any;
  expect(opts.secret).toBe(weak);
  expect(opts.secret).not.toBe("dev-secret");
});
