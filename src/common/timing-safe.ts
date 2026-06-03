import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of a provided token against the expected secret.
 * Returns false on a length mismatch (Node's timingSafeEqual throws on
 * unequal-length buffers, so we bail first) — avoids a timing oracle on a
 * long-lived token. (audit H5)
 */
export function safeTokenEqual(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the token from an `Authorization: Bearer <token>` header value. */
export function bearerToken(authHeader: string | undefined | null): string | undefined {
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) return undefined;
  return authHeader.slice(7);
}
