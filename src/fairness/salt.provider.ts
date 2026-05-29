import { randomBytes } from "node:crypto";

/**
 * Source of the chain-wide salt mixed into every crash computation.
 * Swapping the implementation changes the trust model without touching the
 * rest of the fairness logic.
 *
 *  - DailySaltProvider:  operator-published commit-reveal salt (demo / play-money).
 *  - (later) BlockHashSaltProvider: a future blockchain block hash (real money,
 *    grind-proof).
 */
export interface SaltProvider {
  createSalt(): Promise<string>;
}

export const SALT_PROVIDER = Symbol("SALT_PROVIDER");

/** Demo-grade salt: a fresh random value committed (by hash) per chain. */
export class DailySaltProvider implements SaltProvider {
  async createSalt(): Promise<string> {
    return randomBytes(32).toString("hex");
  }
}
