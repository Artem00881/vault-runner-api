import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SALT_PROVIDER, type SaltProvider } from "./salt.provider";
import { generateSeedChain, verifyChainLink } from "./seed-chain";
import { computeCrash, sha256Hex } from "./crash";

const DEFAULT_CHAIN_LENGTH = 10_000;

function sha256OfUtf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

@Injectable()
export class FairnessService {
  private readonly log = new Logger(FairnessService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SALT_PROVIDER) private readonly saltProvider: SaltProvider,
  ) {}

  /** Generate + persist a seed chain if none exists yet. Returns the commit. */
  async ensureChain(length = DEFAULT_CHAIN_LENGTH) {
    const count = await this.prisma.fairnessSeed.count();
    if (count > 0) return this.getCurrentCommit();

    const salt = await this.saltProvider.createSalt();
    const chain = generateSeedChain(length); // chain[0] = public commit

    // Full seed values are stored server-side; only `revealedAt` gates whether a
    // round's seed has been made public yet (the commit at index 0 is public).
    const rows = chain.map((seed, idx) => ({
      chainIndex: idx,
      seedHash: sha256Hex(seed), // === previous seed (verifiable link)
      seed,
      salt,
      revealedAt: idx === 0 ? new Date() : null,
    }));

    await this.prisma.fairnessSeed.createMany({ data: rows });

    this.log.log(`Generated fairness chain of ${length} seeds (commit ${chain[0].slice(0, 16)}…)`);
    return this.getCurrentCommit();
  }

  /**
   * Reserve the next unused seed for a new round (lowest chain_index >= 1 not
   * yet linked to a round). The game engine runs rounds sequentially, so no
   * concurrency on allocation.
   */
  async allocateSeed() {
    await this.ensureChain();
    const seed = await this.prisma.fairnessSeed.findFirst({
      where: { chainIndex: { gte: 1 }, rounds: { none: {} } },
      orderBy: { chainIndex: "asc" },
    });
    if (!seed) throw new Error("fairness_chain_exhausted");
    return seed;
  }

  /** Compute the (hidden) crash for an allocated seed. */
  crashForSeed(seed: { seed: string | null; salt: string | null }): number {
    return computeCrash(seed.seed!, seed.salt!);
  }

  /** Mark a seed as publicly revealed (after its round crashes). */
  async revealSeed(seedId: string) {
    await this.prisma.fairnessSeed.update({
      where: { id: seedId },
      data: { revealedAt: new Date() },
    });
  }

  /** Public commit info: terminating hash + salt commitment. */
  async getCurrentCommit() {
    const commit = await this.prisma.fairnessSeed.findUnique({ where: { chainIndex: 0 } });
    if (!commit) return null;
    const total = await this.prisma.fairnessSeed.count();
    const revealed = await this.prisma.fairnessSeed.count({ where: { NOT: { revealedAt: null } } });
    return {
      commitHash: commit.seed, // chain[0], published up front
      saltHash: sha256OfUtf8(commit.salt ?? ""),
      houseEdge: 0.03,
      chainLength: total,
      roundsRevealed: Math.max(0, revealed - 1),
      formula: "crash = floor(97 * (2^52 + 1) / (HMAC_SHA256(seed, salt)[:13] + 1)) / 100, min 1.00",
    };
  }

  /**
   * Recompute a crash from a revealed seed + salt (offline-verifiable too).
   * Optionally checks the chain link to the previous revealed seed.
   */
  verify(seed: string, salt: string, prevSeed?: string) {
    const crash = computeCrash(seed, salt);
    const linkOk = prevSeed ? verifyChainLink(seed, prevSeed) : null;
    return { crash, linkVerified: linkOk };
  }
}
