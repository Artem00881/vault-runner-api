import { test, expect, describe, afterEach } from "bun:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  REPORTING_TOKEN_PREFIX,
  generateReportingKey,
  parseReportingToken,
  reportingKeyPepperUnavailable,
  verifyReportingSecret,
} from "../src/operator/reporting-key";

/**
 * Phase 3.5 — operator REPORTING API key (pure, no DB).
 *
 * `reporting-key.ts` mints/parses/verifies the per-operator key presented as
 *   Authorization: Bearer vrk_<operatorId>.<secret>
 * Invariants under test:
 *  - mint → token has the vrk_ prefix, embeds the operatorId, and round-trips
 *    through parseReportingToken;
 *  - the stored value is a HASH of the secret, not the secret (so a DB leak
 *    can't replay the key) — and matches SHA-256(secret) (or HMAC w/ pepper);
 *  - parseReportingToken is STRICT: rejects no-prefix / no-dot / non-UUID id /
 *    empty secret (a garbage id must never reach a @db.Uuid query);
 *  - verifyReportingSecret is constant-time-shaped and FALSE for a wrong secret,
 *    a null stored hash, and wrong-length garbage (timing-safe length bail).
 */

// REPORTING_KEY_PEPPER is read from process.env at hash time and the bun test
// process is SHARED across files — restore it after each test so we never leak a
// pepper into another suite (mirrors metrics-auth env hygiene).
const SAVED_PEPPER = process.env.REPORTING_KEY_PEPPER;
afterEach(() => {
  if (SAVED_PEPPER === undefined) delete process.env.REPORTING_KEY_PEPPER;
  else process.env.REPORTING_KEY_PEPPER = SAVED_PEPPER;
});

describe("generateReportingKey: token format + hash-at-rest", () => {
  test("token has the vrk_ prefix and embeds the operatorId, then round-trips", () => {
    delete process.env.REPORTING_KEY_PEPPER;
    const operatorId = randomUUID();
    const { token, hash } = generateReportingKey(operatorId);

    expect(token.startsWith(REPORTING_TOKEN_PREFIX)).toBe(true);
    expect(token.startsWith(`${REPORTING_TOKEN_PREFIX}${operatorId}.`)).toBe(true);

    const parsed = parseReportingToken(token);
    expect(parsed).not.toBeNull();
    expect(parsed!.operatorId).toBe(operatorId);
    // The secret is the part after the operatorId + ".".
    expect(token).toBe(`${REPORTING_TOKEN_PREFIX}${operatorId}.${parsed!.secret}`);
    // 32 random bytes hex == 64 chars.
    expect(parsed!.secret).toMatch(/^[0-9a-f]{64}$/);

    // The persisted value is the HASH, never the plaintext secret.
    expect(hash).not.toBe(parsed!.secret);
    expect(hash).not.toContain(parsed!.secret);
  });

  test("stored hash is self-describing sha256:<digest> when no pepper is configured", () => {
    delete process.env.REPORTING_KEY_PEPPER;
    const { token, hash } = generateReportingKey(randomUUID());
    const secret = parseReportingToken(token)!.secret;
    expect(hash).toBe(`sha256:${createHash("sha256").update(secret).digest("hex")}`);
  });

  test("stored hash is hmac-sha256:<digest> when REPORTING_KEY_PEPPER is set", () => {
    process.env.REPORTING_KEY_PEPPER = "test-pepper-value";
    const { token, hash } = generateReportingKey(randomUUID());
    const secret = parseReportingToken(token)!.secret;
    expect(hash).toBe(`hmac-sha256:${createHmac("sha256", "test-pepper-value").update(secret).digest("hex")}`);
    // And the digest is NOT the plain SHA-256 (pepper actually changes it).
    expect(hash).not.toBe(`sha256:${createHash("sha256").update(secret).digest("hex")}`);
  });

  test("two mints for the same operator yield distinct secrets + hashes (CSPRNG)", () => {
    delete process.env.REPORTING_KEY_PEPPER;
    const operatorId = randomUUID();
    const a = generateReportingKey(operatorId);
    const b = generateReportingKey(operatorId);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("parseReportingToken: strict parsing", () => {
  const operatorId = "11111111-1111-1111-1111-111111111111";

  test("accepts a well-formed token and splits id/secret at the FIRST dot", () => {
    // Secret may itself contain dots — only the first dot delimits id|secret.
    const parsed = parseReportingToken(`${REPORTING_TOKEN_PREFIX}${operatorId}.aa.bb.cc`);
    expect(parsed).toEqual({ operatorId, secret: "aa.bb.cc" });
  });

  // Table-driven: every malformed shape → null (never throws, never leaks a bad id).
  const malformed: Array<[string, string | undefined | null]> = [
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["no vrk_ prefix", `${operatorId}.secret`],
    ["wrong prefix", `xyz_${operatorId}.secret`],
    ["no dot at all", `${REPORTING_TOKEN_PREFIX}${operatorId}secret`],
    ["dot at position 0 (empty id)", `${REPORTING_TOKEN_PREFIX}.secret`],
    ["trailing dot, empty secret", `${REPORTING_TOKEN_PREFIX}${operatorId}.`],
    ["non-UUID operatorId", `${REPORTING_TOKEN_PREFIX}not-a-uuid.secret`],
    ["operatorId too short", `${REPORTING_TOKEN_PREFIX}1111.secret`],
    ["operatorId with bad chars", `${REPORTING_TOKEN_PREFIX}zzzzzzzz-1111-1111-1111-111111111111.secret`],
    ["prefix only", REPORTING_TOKEN_PREFIX],
  ];
  for (const [label, token] of malformed) {
    test(`rejects ${label} → null`, () => {
      expect(parseReportingToken(token)).toBeNull();
    });
  }

  test("a freshly minted token always parses back to its operatorId", () => {
    delete process.env.REPORTING_KEY_PEPPER;
    const id = randomUUID();
    expect(parseReportingToken(generateReportingKey(id).token)!.operatorId).toBe(id);
  });
});

describe("verifyReportingSecret: constant-time verify", () => {
  test("true for the correct secret against its own hash", () => {
    delete process.env.REPORTING_KEY_PEPPER;
    const { token, hash } = generateReportingKey(randomUUID());
    const secret = parseReportingToken(token)!.secret;
    expect(verifyReportingSecret(secret, hash)).toBe(true);
  });

  test("false for a wrong secret (same length) against a real hash", () => {
    delete process.env.REPORTING_KEY_PEPPER;
    const { hash } = generateReportingKey(randomUUID());
    const wrong = "f".repeat(64); // valid-looking 64-hex secret, but not the one
    expect(verifyReportingSecret(wrong, hash)).toBe(false);
  });

  test("false when the stored hash is null/undefined (not-found path, no throw)", () => {
    delete process.env.REPORTING_KEY_PEPPER;
    expect(verifyReportingSecret("anything", null)).toBe(false);
    expect(verifyReportingSecret("anything", undefined)).toBe(false);
    expect(verifyReportingSecret("anything", "")).toBe(false); // empty string is falsy → false
  });

  test("false for wrong-length garbage stored hash (timing-safe length bail, no throw)", () => {
    delete process.env.REPORTING_KEY_PEPPER;
    const { token } = generateReportingKey(randomUUID());
    const secret = parseReportingToken(token)!.secret;
    // The computed hash is 64 hex chars; a short/long stored value mismatches length.
    expect(verifyReportingSecret(secret, "deadbeef")).toBe(false);
    expect(verifyReportingSecret(secret, "x".repeat(128))).toBe(false);
  });

  test("a hash minted WITH a pepper does NOT verify when the pepper is later unset", () => {
    // The pepper must be identical at mint + verify time; a config drift fails closed.
    process.env.REPORTING_KEY_PEPPER = "pepper-A";
    const { token, hash } = generateReportingKey(randomUUID());
    const secret = parseReportingToken(token)!.secret;
    expect(verifyReportingSecret(secret, hash)).toBe(true); // same pepper → ok

    delete process.env.REPORTING_KEY_PEPPER;
    expect(verifyReportingSecret(secret, hash)).toBe(false); // pepper dropped → mismatch
  });
});

describe("self-describing hash tag (security M-1): drift-resilience", () => {
  test("a sha256 key keeps verifying even after a pepper is LATER set (no silent breakage)", () => {
    // The tag records the algorithm, so verify uses sha256 regardless of the current
    // env — a non-peppered key is immune to a later pepper being added.
    delete process.env.REPORTING_KEY_PEPPER;
    const { token, hash } = generateReportingKey(randomUUID());
    const secret = parseReportingToken(token)!.secret;
    expect(hash.startsWith("sha256:")).toBe(true);
    expect(verifyReportingSecret(secret, hash)).toBe(true);

    process.env.REPORTING_KEY_PEPPER = "pepper-added-later";
    expect(verifyReportingSecret(secret, hash)).toBe(true); // still verifies — tag wins
  });

  test("an unknown/legacy (untagged) stored hash fails closed", () => {
    delete process.env.REPORTING_KEY_PEPPER;
    const { token } = generateReportingKey(randomUUID());
    const secret = parseReportingToken(token)!.secret;
    // 64-hex with no algo prefix (the pre-tag format) → unknown → false.
    expect(verifyReportingSecret(secret, createHash("sha256").update(secret).digest("hex"))).toBe(false);
  });

  test("reportingKeyPepperUnavailable flags a peppered hash only while the pepper is unset", () => {
    process.env.REPORTING_KEY_PEPPER = "p";
    const { hash: peppered } = generateReportingKey(randomUUID());
    delete process.env.REPORTING_KEY_PEPPER;
    const { hash: plain } = generateReportingKey(randomUUID());

    expect(reportingKeyPepperUnavailable(peppered)).toBe(true); // peppered + no pepper now
    expect(reportingKeyPepperUnavailable(plain)).toBe(false); // sha256 key — fine
    expect(reportingKeyPepperUnavailable(null)).toBe(false);
    expect(reportingKeyPepperUnavailable(undefined)).toBe(false);

    process.env.REPORTING_KEY_PEPPER = "p";
    expect(reportingKeyPepperUnavailable(peppered)).toBe(false); // pepper present again
  });
});
