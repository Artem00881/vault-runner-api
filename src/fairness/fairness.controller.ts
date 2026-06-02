import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { FairnessService } from "./fairness.service";

const verifySchema = z.object({
  seed: z.string().regex(/^[0-9a-f]+$/i, "seed must be hex"),
  salt: z.string().min(1),
  prevSeed: z.string().regex(/^[0-9a-f]+$/i).optional(),
});

const REVEALED = new Set(["crashed", "settling", "completed"]);

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

    const revealed = REVEALED.has(round.status);
    if (!revealed) {
      return { roundId: round.id, status: round.status, revealed: false };
    }

    const seed = round.seed.seed!;
    const salt = round.seed.chain.salt!;
    const { crash, linkVerified } = this.fairness.verify(seed, salt);
    return {
      roundId: round.id,
      status: round.status,
      revealed: true,
      seed,
      salt,
      seedHash: round.seed.seedHash,
      chainIndex: round.seed.chainIndex,
      crashPoint: Number(round.crashPoint),
      recomputedCrash: crash,
      matches: Number(round.crashPoint) === crash,
      linkVerified,
    };
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
