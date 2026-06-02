import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SALT_PROVIDER, DailySaltProvider, type SaltProvider, type SaltCommitment } from "./salt.provider";
import { generateSeedChain, verifyChainLink } from "./seed-chain";
import { computeCrash, sha256Hex } from "./crash";

/** Seeds per epoch. Env-tunable (small values let tests/staging observe rollover). */
function chainLength(): number {
  const env = Number(process.env.FAIRNESS_CHAIN_LENGTH);
  return Number.isFinite(env) && env >= 2 ? env : 10_000;
}

function sha256OfUtf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// Epoch status lifecycle:  pending → armed → active → exhausted
//   pending:   committed (chain head + target block published); salt not known yet
//   armed:     salt resolved, on deck to serve next (not the current epoch)
//   active:    the epoch currently serving rounds
//   exhausted: all its seeds have been used

@Injectable()
export class FairnessService {
  private readonly log = new Logger(FairnessService.name);
  /** Safety-net salt source so the game never stalls if the real one is unavailable. */
  private readonly fallback = new DailySaltProvider();
  private maintaining = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SALT_PROVIDER) private readonly saltProvider: SaltProvider,
  ) {}

  /** Ensure an active epoch exists. Returns the public commitment. */
  async ensureChain() {
    await this.ensureActiveChain();
    return this.getCurrentCommit();
  }

  private findActive() {
    return this.prisma.fairnessChain.findFirst({ where: { status: "active" }, orderBy: { epoch: "desc" } });
  }

  /** Return the active epoch, creating/promoting one if needed (random fallback). */
  private async ensureActiveChain() {
    const active = await this.findActive();
    if (active) return active;

    // Promote an already-armed epoch (salt known) to active.
    const armed = await this.prisma.fairnessChain.findFirst({ where: { status: "armed" }, orderBy: { epoch: "asc" } });
    if (armed) return this.promote(armed.id);

    // Try to arm a pending epoch now (its block may already be finalized).
    const pending = await this.prisma.fairnessChain.findFirst({ where: { status: "pending" }, orderBy: { epoch: "asc" } });
    if (pending) {
      const salt = await this.tryResolve(pending);
      if (salt) {
        await this.prisma.fairnessChain.update({ where: { id: pending.id }, data: { salt, armedAt: new Date() } });
        return this.promote(pending.id);
      }
    }

    // Nothing servable → open a fresh active epoch (random fallback if the real
    // salt isn't ready, so play starts immediately).
    return this.createEpoch(true);
  }

  private async promote(id: string) {
    return this.prisma.fairnessChain.update({ where: { id }, data: { status: "active" } });
  }

  /**
   * Open a new epoch (seed chain + salt commitment).
   *  activate=true  → must end up active now (falls back to a random salt if the
   *                   provider's salt isn't available yet, so the game runs).
   *  activate=false → pre-commit: left "pending" (block salt) or "armed" (random).
   */
  private async createEpoch(activate: boolean) {
    const max = await this.prisma.fairnessChain.aggregate({ _max: { epoch: true } });
    const epoch = (max._max.epoch ?? -1) + 1;

    let c: SaltCommitment;
    try {
      c = await this.saltProvider.commit();
    } catch (e) {
      this.log.warn(`epoch ${epoch}: salt commit failed (${String(e)}) → random fallback`);
      c = await this.fallback.commit();
    }
    if (activate && !c.salt) {
      this.log.warn(`epoch ${epoch}: ${c.source} salt not ready → random fallback so play continues`);
      c = await this.fallback.commit();
    }

    const status = c.salt ? (activate ? "active" : "armed") : "pending";
    const len = chainLength();
    const seeds = generateSeedChain(len); // seeds[0] = public commit

    const chain = await this.prisma.fairnessChain.create({
      data: {
        epoch,
        commitHash: seeds[0],
        length: len,
        saltSource: c.source,
        targetChain: c.targetChain ?? null,
        targetBlock: c.targetBlock ?? null,
        salt: c.salt,
        status,
        armedAt: c.salt ? new Date() : null,
      },
    });
    await this.prisma.fairnessSeed.createMany({
      data: seeds.map((seed, idx) => ({
        chainId: chain.id,
        chainIndex: idx,
        seedHash: sha256Hex(seed),
        seed,
        revealedAt: idx === 0 ? new Date() : null,
      })),
    });
    this.log.log(
      `fairness epoch ${epoch} ${status} (${c.source}${c.targetBlock ? ` block ${c.targetBlock}` : ""}, ${len} seeds)`,
    );
    return chain;
  }

  private async tryResolve(chain: {
    saltSource: string;
    salt: string | null;
    targetChain: string | null;
    targetBlock: bigint | null;
    epoch: number;
  }): Promise<string | null> {
    try {
      return await this.saltProvider.resolve({
        source: chain.saltSource,
        salt: chain.salt,
        targetChain: chain.targetChain ?? undefined,
        targetBlock: chain.targetBlock !== null ? Number(chain.targetBlock) : undefined,
      });
    } catch (e) {
      this.log.warn(`epoch ${chain.epoch}: salt resolve failed (${String(e)})`);
      return null;
    }
  }

  /**
   * Per-round maintenance (best-effort, never throws into the engine loop):
   *  1. arm any pending epoch whose block is now finalized;
   *  2. pre-commit the NEXT epoch so its salt is ready before the active one ends.
   */
  async maintain() {
    if (this.maintaining) return;
    this.maintaining = true;
    try {
      const pendings = await this.prisma.fairnessChain.findMany({ where: { status: "pending" }, orderBy: { epoch: "asc" } });
      for (const p of pendings) {
        const salt = await this.tryResolve(p);
        if (salt) {
          await this.prisma.fairnessChain.update({ where: { id: p.id }, data: { salt, status: "armed", armedAt: new Date() } });
          this.log.log(`fairness epoch ${p.epoch} armed (${p.saltSource}${p.targetBlock ? ` block ${p.targetBlock}` : ""})`);
        }
      }
      const active = await this.findActive();
      if (active) {
        const queued = await this.prisma.fairnessChain.count({ where: { status: { in: ["pending", "armed"] } } });
        if (queued === 0) await this.createEpoch(false); // pre-commit next (pending or armed)
      }
    } catch (e) {
      this.log.warn(`fairness maintain failed (best-effort): ${String(e)}`);
    } finally {
      this.maintaining = false;
    }
  }

  /**
   * Reserve the next unused seed for a round. When the active epoch runs out,
   * roll over to a fresh epoch automatically — no exhaustion stall.
   */
  async allocateSeed() {
    const chain = await this.ensureActiveChain();
    let seed = await this.nextUnusedSeed(chain.id);
    if (!seed) {
      await this.prisma.fairnessChain.update({ where: { id: chain.id }, data: { status: "exhausted" } });
      this.log.warn(`fairness epoch ${chain.epoch} exhausted → rolling over`);
      const next = await this.ensureActiveChain(); // promotes armed / arms pending / fallback
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
    await this.prisma.fairnessSeed.update({ where: { id: seedId }, data: { revealedAt: new Date() } });
  }

  /** Public commitment info for the active epoch (+ the pre-committed next one). */
  async getCurrentCommit() {
    const chain = await this.findActive();
    if (!chain) return null;
    const revealed = await this.prisma.fairnessSeed.count({
      where: { chainId: chain.id, NOT: { revealedAt: null } },
    });
    const next = await this.prisma.fairnessChain.findFirst({
      where: { status: { in: ["pending", "armed"] } },
      orderBy: { epoch: "asc" },
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
      // The NEXT epoch is committed in advance — for block-salt its future block is
      // published before it exists (grind-proof), and verifiers can watch it arm.
      nextEpoch: next
        ? {
            epoch: next.epoch,
            commitHash: next.commitHash,
            saltSource: next.saltSource,
            targetChain: next.targetChain,
            targetBlock: next.targetBlock !== null ? Number(next.targetBlock) : null,
            status: next.status, // "pending" (block not finalized) | "armed" (salt known)
          }
        : null,
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
