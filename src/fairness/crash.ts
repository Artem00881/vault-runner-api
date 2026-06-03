import { createHmac, createHash } from "node:crypto";

/**
 * Crash multiplier math.
 *
 * Distribution:  P(crash >= x) = (1 - houseEdge) / x   for x >= 1.00
 * With houseEdge = 0.03 this is exactly 0.97 / x  → 97% RTP / 3% house edge,
 * and ~3% of rounds clamp to 1.00x (instant bust).
 *
 * The result is a deterministic, verifiable function of (seed, salt):
 *   crash = f( HMAC_SHA256(key = seed, message = salt) )
 */

export const HOUSE_EDGE = 0.03;

const E = 2n ** 52n; // 52 bits of entropy taken from the hash
const FACTOR = BigInt(Math.round(100 * (1 - HOUSE_EDGE))); // 97 (in "cents")
const MAX_CENTS = 100_000_000n; // multiplier hard cap = 1,000,000.00x (engine/demo ceiling).
// NB (audit L4): the real-money "10,000x" figure is a per-BET MONEY cap (max win, e.g. €10k),
// NOT a multiplier cap — the crash multiplier itself is always capped HERE at 1,000,000x.

/** Map a hex HMAC/hash to a crash multiplier (2 decimals). */
export function crashFromHmacHex(hex: string): number {
  const h = BigInt("0x" + hex.slice(0, 13)); // 52-bit integer in [0, 2^52)
  let cents = (FACTOR * (E + 1n)) / (h + 1n); // floor division
  if (cents < 100n) cents = 100n; // clamp to 1.00x (instant bust)
  if (cents > MAX_CENTS) cents = MAX_CENTS;
  return Number(cents) / 100;
}

/** Compute the crash for a round from its seed (hex) and the chain salt. */
export function computeCrash(seedHex: string, salt: string): number {
  const hmac = createHmac("sha256", Buffer.from(seedHex, "hex")).update(salt).digest("hex");
  return crashFromHmacHex(hmac);
}

/** SHA-256 of a hex string's bytes, returned as hex (chain link helper). */
export function sha256Hex(hex: string): string {
  return createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
}
