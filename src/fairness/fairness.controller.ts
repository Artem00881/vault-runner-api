import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { FairnessService } from "./fairness.service";

const verifySchema = z.object({
  seed: z.string().regex(/^[0-9a-f]+$/i, "seed must be hex"),
  salt: z.string().min(1),
  prevSeed: z.string().regex(/^[0-9a-f]+$/i).optional(),
});

@Controller("api/fairness")
export class FairnessController {
  constructor(
    private readonly fairness: FairnessService,
    private readonly prisma: PrismaService,
  ) {}

  /** Public commitment for the active chain. */
  @Get("current")
  async current() {
    await this.fairness.ensureChain();
    return this.fairness.getCurrentCommit();
  }

  /** Reveal + verification data for a finished round. */
  @Get("round/:id")
  async round(@Param("id") id: string) {
    const round = await this.prisma.round.findUnique({
      where: { id },
      include: { seed: { include: { chain: true } } },
    });
    if (!round) throw new NotFoundException("round_not_found");

    // Single source of truth for seed disclosure: a round's reveal data is public iff
    // its SEED is revealed (revealedAt set) — the SAME gate as /epoch/:epoch/seeds, so a
    // restart-voided round (forced 'completed' without a reveal) is never disclosed here
    // either (fairness-verifier M4 review: one consistent disclosure rule).
    const revealed = round.seed.revealedAt != null;
    if (!revealed) {
      return { roundId: round.id, status: round.status, revealed: false };
    }

    const seed = round.seed.seed!;
    const salt = round.seed.chain.salt!;
    // Chain link to the published commit: SHA256(seed_k) === seed_{k-1}. Fetch the
    // previous seed so linkVerified is actually populated (audit M4); for chainIndex 1
    // the predecessor is seed[0] = the public commitHash.
    const prev =
      round.seed.chainIndex >= 1
        ? await this.prisma.fairnessSeed.findFirst({
            where: { chainId: round.seed.chainId, chainIndex: round.seed.chainIndex - 1 },
            select: { seed: true },
          })
        : null;
    const { crash, linkVerified } = this.fairness.verify(seed, salt, prev?.seed ?? undefined);
    const chain = round.seed.chain;
    return {
      roundId: round.id,
      status: round.status,
      revealed: true,
      epoch: chain.epoch,
      commitHash: chain.commitHash,
      saltSource: chain.saltSource,
      targetChain: chain.targetChain,
      targetBlock: chain.targetBlock !== null ? Number(chain.targetBlock) : null,
      seed,
      salt,
      seedHash: round.seed.seedHash,
      chainIndex: round.seed.chainIndex,
      prevSeed: prev?.seed ?? null,
      crashPoint: Number(round.crashPoint),
      recomputedCrash: crash,
      matches: Number(round.crashPoint) === crash,
      linkVerified,
    };
  }

  /** Public commitments for ALL epochs (chain-of-custody, incl. exhausted; audit M4). */
  @Get("epochs")
  async epochs() {
    return this.fairness.listEpochs();
  }

  /**
   * Per-epoch REVEALED seed dump for chain-of-custody reconstruction (audit M4).
   * NEVER returns an unrevealed (future) seed — see FairnessService.epochSeeds.
   */
  @Get("epoch/:epoch/seeds")
  async epochSeeds(@Param("epoch") epoch: string) {
    const n = Number(epoch);
    if (!Number.isInteger(n) || n < 0) throw new BadRequestException("invalid_epoch");
    const out = await this.fairness.epochSeeds(n);
    if (!out) throw new NotFoundException("epoch_not_found");
    return out;
  }

  /** Recompute a crash from a seed + salt (clients can also do this offline). */
  @Post("verify")
  verify(@Body() body: unknown) {
    const parsed = verifySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const { seed, salt, prevSeed } = parsed.data;
    return this.fairness.verify(seed, salt, prevSeed);
  }
}
