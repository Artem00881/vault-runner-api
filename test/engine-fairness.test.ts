import { test, expect, afterAll } from "bun:test";
import { PrismaService } from "../src/prisma/prisma.service";
import { computeCrash } from "../src/fairness/crash";

const prisma = new PrismaService();
afterAll(async () => prisma.$disconnect());

/**
 * Validates the engine↔fairness contract against real persisted data:
 * every finished round's stored crashPoint must equal the crash recomputed
 * from its (now revealed) seed + salt. (Requires the engine to have run.)
 */
test("persisted round crash points match the provably-fair recomputation", async () => {
  const rounds = await prisma.round.findMany({
    where: { status: { in: ["crashed", "settling", "completed"] } },
    include: { seed: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  if (rounds.length === 0) {
    console.warn("no finished rounds yet — run the engine first; skipping");
    return;
  }

  for (const r of rounds) {
    const recomputed = computeCrash(r.seed.seed!, r.seed.salt!);
    expect(Number(r.crashPoint)).toBe(recomputed);
  }
  expect(rounds.length).toBeGreaterThan(0);
});
