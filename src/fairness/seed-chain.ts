import { randomBytes } from "node:crypto";
import { sha256Hex } from "./crash";

/**
 * Provably-fair seed chain (bustabit-style).
 *
 * Build:  seed[n-1] = random;  seed[i] = SHA256(seed[i+1]).
 * Commit: publish seed[0] BEFORE any play.
 * Play:   rounds consume seed[1], seed[2], … in order.
 * Verify: for a revealed round seed g_k,  SHA256(g_k) === g_{k-1},
 *         chaining all the way back to the public commit seed[0].
 *
 * Each seed is therefore committed in advance and cannot be altered, while
 * staying secret until its round is revealed.
 */
export function generateSeedChain(length: number): string[] {
  if (length < 2) throw new Error("chain length must be >= 2");
  const chain = new Array<string>(length);
  chain[length - 1] = randomBytes(32).toString("hex");
  for (let i = length - 2; i >= 0; i--) {
    chain[i] = sha256Hex(chain[i + 1]);
  }
  return chain; // chain[0] is the public commit
}

/** True if `seed` is the chain predecessor of `prevSeed` (SHA256(seed) === prevSeed). */
export function verifyChainLink(seed: string, prevSeed: string): boolean {
  return sha256Hex(seed) === prevSeed;
}
