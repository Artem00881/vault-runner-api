import { Controller, Get, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { GameEngineService } from "./game-engine.service";

const FINISHED = ["crashed", "settling", "completed"];

@Controller("api")
export class RoundsController {
  constructor(
    @Inject(GameEngineService) private readonly engine: GameEngineService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** Current round snapshot (no crash leak). */
  @Get("round/current")
  current() {
    return this.engine.getPublicState() ?? { phase: "waiting", multiplier: 1.0 };
  }

  /** Recent finished rounds with their (now public) crash multipliers. */
  @Get("rounds/history")
  async history() {
    const rows = await this.prisma.round.findMany({
      where: { status: { in: FINISHED } },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, crashPoint: true, createdAt: true },
    });
    return rows.map((r) => ({ id: r.id, crashMult: Number(r.crashPoint), endedAt: r.createdAt }));
  }
}
