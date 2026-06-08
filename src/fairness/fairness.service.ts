import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditEventService } from "../audit/audit-event.service";
import { MetricsService } from "../metrics/metrics.service";
import { SALT_PROVIDER, DailySaltProvider, type SaltProvider, type SaltCommitment } from "./salt.provider";
import { generateSeedChain, verifyChainLink } from "./seed-chain";
import { computeCrash, sha256Hex } from "./crash";

/** Seeds per epoch. Env-tunable (small values let tests/staging observe rollover). */
function chainLength(): number {
  const env = Number(process.env.FAIRNESS_CHAIN_LENGTH);
  return Number.isFinite(env) && env >= 2 ? env : 10_000;
}

/**
 * Real-money grind-proofing guard (audit M6). When set, the engine will NEVER open
 * rounds on a server-generated random-salt fallback (which would be grindable) or
 * orphan a pre-committed block epoch — it STALLS until the committed block salt
 * resolves. Default OFF: the demo/play-money build favours availability (a transparent
 * random fallback, surfaced via saltSource) since there's no real money to grind for.
 */
function requireBlockSalt(): boolean {
  return process.env.FAIRNESS_REQUIRE_BLOCK_SALT === "true";
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
    @Inject(AuditEventService) private readonly audit: AuditEventService,
    // Optional so existing 3-arg `new FairnessService(...)` test constructions keep
    // compiling; every call site guards with `?.`. When wired by Nest DI it's present.
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
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
    const strict = requireBlockSalt();
    const active = await this.findActive();
    // Strict (real-money): never SERVE a non-block-salt epoch — retire a pre-existing
    // random active/armed epoch (e.g. one left by a play→real-money flip) and roll to a
    // block epoch, instead of serving up to a full chain of grindable rounds (audit M6/M1).
    if (active) {
      if (strict && active.saltSource !== "eth-block") await this.retireChain(active);
      else return active;
    }

    // Promote an already-armed epoch (salt known) to active.
    const armed = await this.prisma.fairnessChain.findFirst({ where: { status: "armed" }, orderBy: { epoch: "asc" } });
    if (armed) {
      if (strict && armed.saltSource !== "eth-block") await this.retireChain(armed);
      else return this.promote(armed.id);
    }

    // Try to arm a pending epoch now (its block may already be finalized).
    const pending = await this.prisma.fairnessChain.findFirst({ where: { status: "pending" }, orderBy: { epoch: "asc" } });
    if (pending) {
      const salt = await this.tryResolve(pending);
      if (salt) {
        await this.prisma.fairnessChain.update({ where: { id: pending.id }, data: { salt, armedAt: new Date() } });
        return this.promote(pending.id);
      }
    }

    // Nothing servable → open a fresh active epoch (random fallback if the real salt
    // isn't ready; strict refuses the random fallback → returns null so the caller stalls).
    return this.createEpoch(true);
  }

  /** Retire a chain (mark exhausted) — drops a non-block-salt epoch under strict mode. */
  private async retireChain(chain: { id: string; epoch: number; saltSource: string }) {
    await this.prisma.fairnessChain.update({ where: { id: chain.id }, data: { status: "exhausted" } });
    this.log.warn(`epoch ${chain.epoch}: "${chain.saltSource}"-salt epoch retired under FAIRNESS_REQUIRE_BLOCK_SALT (not grind-proof)`);
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
    const strict = requireBlockSalt();

    // Track whether we substituted the random safety-net salt — that fact must become a
    // QUERYABLE significant event (F-058 / cert ask: "the salt fell back to random").
    let fallback: { reason: string; from: string } | undefined;

    let c: SaltCommitment;
    try {
      c = await this.saltProvider.commit();
    } catch (e) {
      // Real-money: don't mint a grindable random epoch — stall until the oracle is back.
      if (strict) {
        this.log.warn(`epoch ${epoch}: salt commit failed and FAIRNESS_REQUIRE_BLOCK_SALT set — refusing random fallback (${String(e)})`);
        this.metrics?.recordSaltFallback("commit_failed", "strict");
        return null;
      }
      this.log.warn(`epoch ${epoch}: salt commit failed (${String(e)}) → random fallback`);
      this.metrics?.recordSaltFallback("commit_failed", "fallback");
      fallback = { reason: "commit_failed", from: this.saltProvider.constructor.name };
      c = await this.fallback.commit();
    }
    if (activate && !c.salt) {
      // The committed (block) salt isn't resolved yet. In real-money mode do NOT substitute
      // a grindable random salt or orphan the pre-committed block epoch — return null so the
      // caller stalls and retries until the block finalizes (audit M6).
      if (strict) {
        this.log.warn(`epoch ${epoch}: ${c.source} salt not ready and FAIRNESS_REQUIRE_BLOCK_SALT set — stalling, no random fallback`);
        this.metrics?.recordSaltFallback("salt_not_ready", "strict");
        return null;
      }
      this.log.warn(`epoch ${epoch}: ${c.source} salt not ready → random fallback so play continues`);
      this.metrics?.recordSaltFallback("salt_not_ready", "fallback");
      fallback = { reason: "salt_not_ready", from: c.source };
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

    // Significant-event audit log (F-058). All best-effort (never block the round):
    //  - epoch_commit: a fresh epoch's public commit was published (commitHash = seed[0]);
    //  - salt_fallback: we substituted the grindable random safety-net salt (cert-relevant);
    //  - salt_armed: this epoch's salt is already known (random / pre-resolved block) at open.
    await this.audit.record({
      actor: "system",
      action: "rng.epoch_commit",
      targetType: "rng_epoch",
      targetId: String(epoch),
      meta: {
        epoch,
        status,
        saltSource: c.source,
        commitHash: seeds[0],
        targetChain: c.targetChain ?? null,
        targetBlock: c.targetBlock != null ? String(c.targetBlock) : null,
        length: len,
      },
    });
    if (fallback) {
      await this.audit.record({
        actor: "system",
        action: "rng.salt_fallback",
        targetType: "rng_epoch",
        targetId: String(epoch),
        meta: { epoch, reason: fallback.reason, fellBackFrom: fallback.from, saltSource: c.source },
      });
    }
    if (c.salt) {
      await this.audit.record({
        actor: "system",
        action: "rng.salt_armed",
        targetType: "rng_epoch",
        targetId: String(epoch),
        // sha256OfUtf8 matches the PUBLIC salt-hash in getCurrentCommit (a salt is an
        // arbitrary string, not hex) so the audited hash equals the published one.
        meta: { epoch, status, saltSource: c.source, saltHash: sha256OfUtf8(c.salt) },
      });
    }
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
          // F-058: a pending (block) epoch's committed salt finalized → armed. Best-effort.
          await this.audit.record({
            actor: "system",
            action: "rng.salt_armed",
            targetType: "rng_epoch",
            targetId: String(p.epoch),
            meta: {
              epoch: p.epoch,
              status: "armed",
              saltSource: p.saltSource,
              saltHash: sha256OfUtf8(salt),
              targetBlock: p.targetBlock != null ? String(p.targetBlock) : null,
            },
          });
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
    if (!chain) return null; // STALL: real-money guard, committed block salt not ready (audit M6)
    let seed = await this.nextUnusedSeed(chain.id);
    if (!seed) {
      await this.prisma.fairnessChain.update({ where: { id: chain.id }, data: { status: "exhausted" } });
      this.log.warn(`fairness epoch ${chain.epoch} exhausted → rolling over`);
      const next = await this.ensureActiveChain(); // promotes armed / arms pending / fallback
      if (!next) return null; // STALL on rollover: the next block epoch hasn't resolved yet
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
   * Public commitment list for ALL epochs (incl. exhausted) — lets a third party see
   * every epoch's published commit + salt source/target for the full chain-of-custody,
   * not just the active one (audit M4). The RAW salt is included only once it has served
   * rounds (active/exhausted); a future epoch (pending/armed) shows only the committed
   * saltHash, so no unrevealed seed could be pre-computed from it.
   */
  async listEpochs() {
    const chains = await this.prisma.fairnessChain.findMany({ orderBy: { epoch: "asc" } });
    return Promise.all(
      chains.map(async (c) => {
        const revealed = await this.prisma.fairnessSeed.count({
          where: { chainId: c.id, NOT: { revealedAt: null } },
        });
        const saltPublic = c.status === "active" || c.status === "exhausted";
        return {
          epoch: c.epoch,
          commitHash: c.commitHash,
          saltSource: c.saltSource,
          salt: saltPublic ? c.salt : null,
          saltHash: c.salt ? sha256OfUtf8(c.salt) : null,
          targetChain: c.targetChain,
          targetBlock: c.targetBlock !== null ? Number(c.targetBlock) : null,
          length: c.length,
          status: c.status,
          roundsRevealed: Math.max(0, revealed - 1),
          createdAt: c.createdAt,
          armedAt: c.armedAt,
        };
      }),
    );
  }

  /**
   * Per-epoch REVEALED seed dump for chain-of-custody reconstruction (audit M4).
   * SECURITY: returns ONLY seeds whose round has been revealed (revealedAt set). An
   * UNrevealed seed would let anyone pre-compute a future round's crash, so it is NEVER
   * exposed — SHA256 is one-way, so the revealed prefix discloses nothing about the next
   * (still-secret) seed. seed[0] (the public commit) is revealed by construction. Returns
   * null if the epoch doesn't exist.
   */
  async epochSeeds(epoch: number) {
    const chain = await this.prisma.fairnessChain.findUnique({ where: { epoch } });
    if (!chain) return null;
    const seeds = await this.prisma.fairnessSeed.findMany({
      where: { chainId: chain.id, NOT: { revealedAt: null } }, // revealed ONLY — never leak a future seed
      orderBy: { chainIndex: "asc" },
      select: { chainIndex: true, seed: true, seedHash: true, revealedAt: true },
    });
    const saltPublic = chain.status === "active" || chain.status === "exhausted";
    return {
      epoch: chain.epoch,
      commitHash: chain.commitHash,
      saltSource: chain.saltSource,
      salt: saltPublic ? chain.salt : null,
      targetChain: chain.targetChain,
      targetBlock: chain.targetBlock !== null ? Number(chain.targetBlock) : null,
      status: chain.status,
      length: chain.length,
      revealedCount: seeds.length,
      seeds,
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
