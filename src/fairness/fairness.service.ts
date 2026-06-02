import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SALT_PROVIDER, type SaltProvider } from "./salt.provider";
import { generateSeedChain, verifyChainLink } from "./seed-chain";
import { computeCrash, sha256Hex } from "./crash";

/** Seeds per epoch. Env-tunable (small values let tests/staging observe rollover). */
function chainLength(explicit?: number): number {
  if (explicit && explicit >= 2) return explicit;
  const env = Number(process.env.FAIRNESS_CHAIN_LENGTH);
  return Number.isFinite(env) && env >= 2 ? env : 10_000;
}

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

  /** Ensure an active epoch exists (create epoch 0 if none). Returns the commit. */
  async ensureChain(length?: number) {
    await this.ensureActiveChain(length);
    return this.getCurrentCommit();
  }

  private async ensureActiveChain(length?: number) {
    const active = await this.prisma.fairnessChain.findFirst({
      where: { status: "active" },
      orderBy: { epoch: "desc" },
    });
    return active ?? this.createEpoch(length);
  }

  /** Generate + persist a new epoch (seed chain + salt) and activate it. */
  private async createEpoch(length?: number) {
    const len = chainLength(length);
    const max = await this.prisma.fairnessChain.aggregate({ _max: { epoch: true } });
    const epoch = (max._max.epoch ?? -1) + 1;
    const salt = await this.saltProvider.createSalt();
    const seeds = generateSeedChain(len); // seeds[0] = public commit

    const chain = await this.prisma.fairnessChain.create({
      data: {
        epoch,
        commitHash: seeds[0],
        length: len,
        saltSource: "random",
        salt,
        status: "active",
        armedAt: new Date(),
      },
    });

    // Full seed values are stored server-side; `revealedAt` gates publicness.
    // The commit (index 0) is public from the start.
    await this.prisma.fairnessSeed.createMany({
      data: seeds.map((seed, idx) => ({
        chainId: chain.id,
        chainIndex: idx,
        seedHash: sha256Hex(seed), // === previous seed (verifiable link)
        seed,
        revealedAt: idx === 0 ? new Date() : null,
      })),
    });

    this.log.log(`fairness epoch ${epoch} created (commit ${seeds[0].slice(0, 16)}…, ${len} seeds)`);
    return chain;
  }

  /**
   * Reserve the next unused seed for a round. When the active epoch runs out,
   * automatically roll over to a fresh epoch — no exhaustion stall.
   */
  async allocateSeed() {
    const chain = await this.ensureActiveChain();
    let seed = await this.nextUnusedSeed(chain.id);
    if (!seed) {
      await this.prisma.fairnessChain.update({
        where: { id: chain.id },
        data: { status: "exhausted" },
      });
      this.log.warn(`fairness epoch ${chain.epoch} exhausted → rolling over`);
      const next = await this.createEpoch();
      seed = await this.nextUnusedSeed(next.id);
      if (!seed) throw new Error("fairness_chain_exhausted"); // unreachable (fresh epoch)
    }
    return seed;
  }

  private nextUnusedSeed(chainId: string) {
    return this.prisma.fairnessSeed.findFirst({
      where: { chainId, chainIndex: { gte: 1 }, rounds: { none: {} } },
      orderBy: { chainIndex: "asc" },
      include: { chain: { select: { salt: true, epoch: true } } },
    });
  }

  /** Compute the (hidden) crash for an allocated seed (uses its epoch's salt). */
  crashForSeed(seed: { seed: string | null; chain: { salt: string | null } }): number {
    return computeCrash(seed.seed!, seed.chain.salt!);
  }

  /** Mark a seed as publicly revealed (after its round crashes). */
  async revealSeed(seedId: string) {
    await this.prisma.fairnessSeed.update({
      where: { id: seedId },
      data: { revealedAt: new Date() },
    });
  }

  /** Public commitment info for the active epoch. */
  async getCurrentCommit() {
    const chain = await this.prisma.fairnessChain.findFirst({
      where: { status: "active" },
      orderBy: { epoch: "desc" },
    });
    if (!chain) return null;
    const revealed = await this.prisma.fairnessSeed.count({
      where: { chainId: chain.id, NOT: { revealedAt: null } },
    });
    return {
      epoch: chain.epoch,
      commitHash: chain.commitHash, // chain[0], published up front
      saltSource: chain.saltSource,
      saltHash: chain.salt ? sha256OfUtf8(chain.salt) : null,
      targetChain: chain.targetChain,
      targetBlock: chain.targetBlock !== null ? Number(chain.targetBlock) : null,
      houseEdge: 0.03,
      chainLength: chain.length,
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
