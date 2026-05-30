import { Controller, Get, Inject, Query } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("api/leaderboard")
export class LeaderboardController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Most Wanted — top thieves by biggest escape, then total loot. */
  @Get()
  async list(@Query("limit") limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const rows = await this.prisma.profile.findMany({
      orderBy: [{ biggestMultiplier: "desc" }, { totalLoot: "desc" }],
      take,
      select: { userId: true, displayName: true, biggestMultiplier: true, totalLoot: true },
    });
    return rows.map((p) => ({
      id: p.userId,
      display_name: p.displayName,
      biggest_multiplier: Number(p.biggestMultiplier),
      total_loot: Number(p.totalLoot),
    }));
  }
}
