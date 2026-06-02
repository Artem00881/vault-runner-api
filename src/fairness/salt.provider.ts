import { randomBytes } from "node:crypto";
import { finalizedBlockNumber, finalizedBlockHash } from "./eth-block";

/**
 * Source of the chain-wide salt mixed into every crash computation. Swapping the
 * implementation changes the trust model without touching the rest of the
 * fairness logic.
 *
 * Two-phase by design, to support a salt that is not known at commit time:
 *  - commit():  open a new epoch's salt — returns it immediately (random) or a
 *               public target (a future block) whose salt is resolved later.
 *  - resolve(): turn a pending commitment into a final salt, or null if it is
 *               not available yet.
 *
 *  - DailySaltProvider:        operator-published random salt (demo / play-money).
 *  - EthBlockSaltProvider:     a future, finalized Ethereum block hash — grind-proof
 *                              (the salt does not exist when the epoch is committed).
 */
export interface SaltCommitment {
  source: string; // "random" | "eth-block"
  salt: string | null; // known now (random) or null until resolved (eth-block)
  targetChain?: string; // e.g. "ethereum"
  targetBlock?: number; // committed future block height
}

export interface SaltProvider {
  readonly source: string;
  /** Open a salt commitment for a new epoch. */
  commit(): Promise<SaltCommitment>;
  /** Resolve a pending commitment to a final salt, or null if not ready yet. */
  resolve(commitment: SaltCommitment): Promise<string | null>;
}

export const SALT_PROVIDER = Symbol("SALT_PROVIDER");

/** Demo-grade salt: a fresh random value, known immediately. */
export class DailySaltProvider implements SaltProvider {
  readonly source = "random";
  async commit(): Promise<SaltCommitment> {
    return { source: "random", salt: randomBytes(32).toString("hex") };
  }
  async resolve(commitment: SaltCommitment): Promise<string | null> {
    return commitment.salt; // already known
  }
}

/**
 * Grind-proof salt: the hash of a FUTURE finalized Ethereum block. At commit time
 * we publish only the target block height (the block does not exist yet), so the
 * salt cannot be ground against the pre-committed seed chain. Once the block is
 * finalized, its hash becomes the salt.
 */
export class EthBlockSaltProvider implements SaltProvider {
  readonly source = "eth-block";

  private lead(): number {
    const n = Number(process.env.ETH_SALT_LEAD_BLOCKS);
    return Number.isFinite(n) && n >= 1 ? n : 10;
  }

  async commit(): Promise<SaltCommitment> {
    const head = await finalizedBlockNumber();
    return { source: "eth-block", salt: null, targetChain: "ethereum", targetBlock: head + this.lead() };
  }

  async resolve(commitment: SaltCommitment): Promise<string | null> {
    if (commitment.salt) return commitment.salt;
    if (!commitment.targetBlock) return null;
    return finalizedBlockHash(commitment.targetBlock);
  }
}
