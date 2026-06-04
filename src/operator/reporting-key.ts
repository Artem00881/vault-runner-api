import { createHash, createHmac, randomBytes } from "node:crypto";
import { safeTokenEqual } from "../common/timing-safe";
import { UUID_RE } from "../common/uuid";

/**
 * Operator REPORTING API key (Phase 3.5). An operator authenticates to the B2B
 * reporting surface with a per-operator key, presented as:
 *
 *     Authorization: Bearer vrk_<operatorId>.<secret>
 *
 * The `<operatorId>` prefix is a NON-secret lookup key (it is the operator's UUID,
 * already present in launch tokens) so the guard does ONE indexed findUnique instead
 * of hashing every row (which would be slow and a timing oracle). The `<secret>` is
 * 32 bytes of CSPRNG entropy. We store ONLY the hash (`Operator.reportingApiKeyHash`)
 * — the key is only ever VERIFIED, never used to sign, so it can and must be hashed
 * at rest (unlike launchSecret/walletApiKey, which must stay plaintext to be used).
 *
 * The stored hash is SELF-DESCRIBING: "<algo>:<hex>" where algo ∈ {sha256, hmac-sha256}.
 *  - plain SHA-256(secret) when no pepper is configured;
 *  - HMAC-SHA256(REPORTING_KEY_PEPPER, secret) when the pepper env is set.
 * A plain SHA-256 of a 256-bit random secret is already preimage-resistant (no
 * dictionary to attack — unlike a human password, so argon2/bcrypt's slow-hash
 * rationale doesn't apply, and we avoid a native-addon dependency). The optional
 * pepper adds defense against a DB-only leak.
 *
 * WHY the algo tag (security M-1 hardening): verify uses the algorithm RECORDED IN
 * THE HASH, not the current env. So a `sha256:` key keeps verifying even if a pepper
 * is later set (no silent fleet-wide breakage), and a `hmac-sha256:` key whose pepper
 * is missing fails DETERMINISTICALLY (and is surfaced by reportingKeyPepperUnavailable
 * → a distinct log) instead of silently mismatching. The pepper must still be present
 * to verify a peppered key — there is no way around that — but the failure is now
 * diagnosable rather than a generic "wrong key".
 */
export const REPORTING_TOKEN_PREFIX = "vrk_";

const ALGO_SHA = "sha256";
const ALGO_HMAC = "hmac-sha256";

const sha256 = (secret: string): string => createHash("sha256").update(secret).digest("hex");
const hmac256 = (secret: string, pepper: string): string =>
  createHmac("sha256", pepper).update(secret).digest("hex");

/** Mint a fresh key for an operator: returns the one-time plaintext token + its
 *  self-describing stored hash ("<algo>:<hex>"). */
export function generateReportingKey(operatorId: string): { token: string; hash: string } {
  const secret = randomBytes(32).toString("hex");
  const pepper = process.env.REPORTING_KEY_PEPPER;
  const hash = pepper ? `${ALGO_HMAC}:${hmac256(secret, pepper)}` : `${ALGO_SHA}:${sha256(secret)}`;
  return { token: `${REPORTING_TOKEN_PREFIX}${operatorId}.${secret}`, hash };
}

/** Parse a presented token into { operatorId, secret }, or null if malformed.
 *  Validates the operatorId is a UUID so a garbage id never reaches a @db.Uuid query
 *  (which would throw a 500 instead of a clean 401). */
export function parseReportingToken(
  token: string | undefined | null,
): { operatorId: string; secret: string } | null {
  if (typeof token !== "string" || !token.startsWith(REPORTING_TOKEN_PREFIX)) return null;
  const body = token.slice(REPORTING_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot >= body.length - 1) return null;
  const operatorId = body.slice(0, dot);
  const secret = body.slice(dot + 1);
  if (!UUID_RE.test(operatorId) || !secret) return null;
  return { operatorId, secret };
}

/** True when the stored hash is peppered but REPORTING_KEY_PEPPER is unset — i.e. the
 *  key CANNOT be verified until the pepper is restored. The guard logs this distinctly
 *  so a pepper-drift outage is diagnosable instead of looking like a wrong key. */
export function reportingKeyPepperUnavailable(storedHash: string | null | undefined): boolean {
  return typeof storedHash === "string" && storedHash.startsWith(`${ALGO_HMAC}:`) && !process.env.REPORTING_KEY_PEPPER;
}

/** Constant-time verify a presented secret against the stored "<algo>:<hex>" hash.
 *  ALWAYS computes a hash (even on the not-found / can't-verify paths) to flatten the
 *  timing. Uses the algorithm RECORDED in the hash, not the current env. */
export function verifyReportingSecret(secret: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) {
    sha256(secret); // hash unconditionally (timing flatten) then bail
    return false;
  }
  const idx = storedHash.indexOf(":");
  const algo = idx > 0 ? storedHash.slice(0, idx) : "";
  const digest = idx > 0 ? storedHash.slice(idx + 1) : "";
  let computed: string;
  if (algo === ALGO_HMAC) {
    const pepper = process.env.REPORTING_KEY_PEPPER;
    if (!pepper) {
      sha256(secret); // can't verify a peppered key without the pepper — fail closed
      return false;
    }
    computed = hmac256(secret, pepper);
  } else if (algo === ALGO_SHA) {
    computed = sha256(secret);
  } else {
    sha256(secret); // unknown/legacy format — fail closed
    return false;
  }
  return safeTokenEqual(computed, digest);
}
