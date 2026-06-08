import { test, expect, describe } from "bun:test";
import { sanitizeAuditPayload } from "../src/audit/audit-event.service";

/**
 * Unit tests for the defense-in-depth audit-payload scrubber (F-058 hardening tweak 3).
 * It is a SAFETY NET — callers already scrub — so it must be pure, never throw, redact
 * secret-looking keys (keeping the key), cap oversized fields, and leave the public
 * provably-fair artifacts (saltHash/commitHash/hashPrefix) untouched.
 */
describe("sanitizeAuditPayload", () => {
  test("passes primitives / null / undefined through unchanged", () => {
    expect(sanitizeAuditPayload(undefined)).toBeUndefined();
    expect(sanitizeAuditPayload(null)).toBeNull();
    expect(sanitizeAuditPayload(42)).toBe(42);
    expect(sanitizeAuditPayload("hello")).toBe("hello");
    expect(sanitizeAuditPayload(true)).toBe(true);
  });

  test("redacts the VALUE of secret-looking keys but keeps the key", () => {
    const out = sanitizeAuditPayload({
      apiKey: "AKIA-super-secret",
      api_key: "x",
      password: "hunter2",
      passwd: "hunter2",
      walletApiKey: "wallet-key",
      privateKey: "-----BEGIN-----",
      private_key: "y",
      launchSecret: "hmac-seed",
      accessToken: "jwt.here",
      operatorId: "op-1",
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[redacted]");
    expect(out.api_key).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect(out.passwd).toBe("[redacted]");
    expect(out.walletApiKey).toBe("[redacted]");
    expect(out.privateKey).toBe("[redacted]");
    expect(out.private_key).toBe("[redacted]");
    expect(out.launchSecret).toBe("[redacted]");
    expect(out.accessToken).toBe("[redacted]"); // contains "token"
    // keys themselves remain present (visible that a field existed)
    expect(Object.keys(out)).toContain("password");
    // non-secret value passes through
    expect(out.operatorId).toBe("op-1");
  });

  test("matches case-insensitively and as a substring", () => {
    const out = sanitizeAuditPayload({
      SECRET: "a",
      reportingApiKeyHash: "b", // contains "apikey"
      refreshTOKEN: "c",
    }) as Record<string, unknown>;
    expect(out.SECRET).toBe("[redacted]");
    expect(out.reportingApiKeyHash).toBe("[redacted]");
    expect(out.refreshTOKEN).toBe("[redacted]");
  });

  test("does NOT redact public provably-fair artifacts", () => {
    const out = sanitizeAuditPayload({
      saltHash: "abc123",
      commitHash: "def456",
      hashPrefix: "00ff",
      hash: "plain",
    }) as Record<string, unknown>;
    expect(out.saltHash).toBe("abc123");
    expect(out.commitHash).toBe("def456");
    expect(out.hashPrefix).toBe("00ff");
    expect(out.hash).toBe("plain");
  });

  test("deep-walks nested objects and arrays", () => {
    const out = sanitizeAuditPayload({
      level1: {
        level2: { password: "deep", keep: "ok" },
        list: [{ token: "t1" }, { ok: "v" }, "scalar"],
      },
    }) as any;
    expect(out.level1.level2.password).toBe("[redacted]");
    expect(out.level1.level2.keep).toBe("ok");
    expect(out.level1.list[0].token).toBe("[redacted]");
    expect(out.level1.list[1].ok).toBe("v");
    expect(out.level1.list[2]).toBe("scalar");
  });

  test("size guard: replaces an oversized field with a stub", () => {
    const big = { blob: "x".repeat(20000) };
    const out = sanitizeAuditPayload(big) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
    expect(typeof out.bytes).toBe("number");
    expect(out.bytes as number).toBeGreaterThan(16384);
  });

  test("keeps a field that is large but under the cap", () => {
    const ok = { blob: "x".repeat(1000) };
    const out = sanitizeAuditPayload(ok) as Record<string, unknown>;
    expect(out.blob).toBe("x".repeat(1000));
    expect(out.truncated).toBeUndefined();
  });

  test("never throws on a circular structure (degrades to a stub or marker)", () => {
    const a: any = { name: "root" };
    a.self = a;
    expect(() => sanitizeAuditPayload(a)).not.toThrow();
    const out = sanitizeAuditPayload(a) as any;
    // either the circular marker survived, or the whole thing got stubbed — both are safe
    expect(out.self === "[circular]" || out.truncated === true).toBe(true);
  });

  test("never throws on a throwing getter (degrades to a stub)", () => {
    const evil = {
      get boom(): string {
        throw new Error("nope");
      },
    };
    expect(() => sanitizeAuditPayload(evil)).not.toThrow();
    const out = sanitizeAuditPayload(evil) as any;
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBe(-1);
  });
});
