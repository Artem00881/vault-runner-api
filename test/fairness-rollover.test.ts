import { test, expect, afterAll } from "bun:test";
import { PrismaService } from "../src/prisma/prisma.service";
import { FairnessService } from "../src/fairness/fairness.service";
import { DailySaltProvider } from "../src/fairness/salt.provider";
import { computeCrash, sha256Hex } from "../src/fairness/crash";

const prisma = new PrismaService();
const fairness = new FairnessService(prisma, new DailySaltProvider());

const createdRoundIds: string[] = [];
const createdChainIds: string[] = [];

afterAll(async () => {
  try {
    if (createdRoundIds.length)
      await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdChainIds.length) {
      await prisma.fairnessSeed.deleteMany({ where: { chainId: { in: createdChainIds } } });
      await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    }
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

// Mark a seed "used" by attaching a round (status OUTSIDE the revealed set, so the
// engine-fairness scan ignores these synthetic rounds). crashPoint is the real
// computed value, so it stays internally consistent either way.
async function useSeed(seed: { id: string; seed: string | null; chain: { salt: string | null } }) {
  const crash = computeCrash(seed.seed!, seed.chain.salt!);
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 0n, crashPoint: crash, status: "running", bettingOpensAt: new Date() },
  });
  createdRoundIds.push(round.id);
}

test("active epoch exhaustion rolls over to a fresh epoch (no stall)", async () => {
  // This test must exhaust an epoch, only practical with a tiny one on a clean DB.
  // Skip if a real (large) active epoch already exists (shared/populated DB).
  const existingActive = await prisma.fairnessChain.findFirst({ where: { status: "active" } });
  if (existingActive && existingActive.length > 8) {
    console.warn(
      `active epoch ${existingActive.epoch} (len ${existingActive.length}) present — skipping rollover test (run on a clean DB / CI)`,
    );
    return;
  }

  process.env.FAIRNESS_CHAIN_LENGTH = "3"; // tiny epochs: seeds [0,1,2]; only 1,2 are playable

  // --- Epoch A --- (length comes from FAIRNESS_CHAIN_LENGTH set above)
  await fairness.ensureChain();
  const a = await fairness.getCurrentCommit();
  expect(a).not.toBeNull();
  const chainA = await prisma.fairnessChain.findFirst({ where: { epoch: a!.epoch } });
  createdChainIds.push(chainA!.id);

  // Exhaust epoch A — allocate + use its two playable seeds (indices 1, 2).
  const s1 = await fairness.allocateSeed();
  expect(typeof s1.chain.salt).toBe("string");
  await useSeed(s1);
  const s2 = await fairness.allocateSeed();
  await useSeed(s2);

  // --- Next allocate must ROLL OVER to a new epoch ---
  const s3 = await fairness.allocateSeed();
  const chainB = await prisma.fairnessChain.findUnique({ where: { id: s3.chainId } });
  expect(chainB).not.toBeNull();
  if (!createdChainIds.includes(chainB!.id)) createdChainIds.push(chainB!.id);
  await useSeed(s3);

  // Rolled over to a strictly newer, active epoch; A is now exhausted.
  expect(chainB!.epoch).toBeGreaterThan(a!.epoch);
  expect(chainB!.status).toBe("active");
  const reloadedA = await prisma.fairnessChain.findUnique({ where: { id: chainA!.id } });
  expect(reloadedA!.status).toBe("exhausted");

  // Current commit now points at the new epoch, with a fresh commit hash.
  const b = await fairness.getCurrentCommit();
  expect(b!.epoch).toBe(chainB!.epoch);
  expect(b!.commitHash).not.toBe(a!.commitHash);

  // The new epoch is a valid provably-fair chain: SHA256(seed[1]) === seed[0] (commit).
  const seed1 = await prisma.fairnessSeed.findFirst({ where: { chainId: chainB!.id, chainIndex: 1 } });
  expect(seed1!.seedHash).toBe(b!.commitHash);
  expect(sha256Hex(seed1!.seed!)).toBe(seed1!.seedHash);
});
