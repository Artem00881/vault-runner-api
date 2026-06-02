import { test, expect, afterAll } from "bun:test";
import { PrismaService } from "../src/prisma/prisma.service";
import { FairnessService } from "../src/fairness/fairness.service";
import type { SaltProvider, SaltCommitment } from "../src/fairness/salt.provider";
import { computeCrash } from "../src/fairness/crash";

const prisma = new PrismaService();

// Controllable block-salt-like provider: commit() returns a pending commitment;
// resolve() stays null until `ready`, then yields a fixed block hash.
class FakeBlockProvider implements SaltProvider {
  readonly source = "eth-block";
  ready = false;
  private block = 0;
  async commit(): Promise<SaltCommitment> {
    this.block += 1000;
    return { source: "eth-block", salt: null, targetChain: "ethereum", targetBlock: this.block };
  }
  async resolve(c: SaltCommitment): Promise<string | null> {
    if (c.salt) return c.salt;
    return this.ready ? BLOCK_HASH : null;
  }
}

const BLOCK_HASH = "0x" + "ab".repeat(32);
const fake = new FakeBlockProvider();
const fairness = new FairnessService(prisma, fake);

const createdChainIds: string[] = [];
const createdRoundIds: string[] = [];
afterAll(async () => {
  try {
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdChainIds.length) {
      await prisma.fairnessSeed.deleteMany({ where: { chainId: { in: createdChainIds } } });
      await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    }
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

async function exhaust(chainId: string) {
  const seeds = await prisma.fairnessSeed.findMany({ where: { chainId, chainIndex: { gte: 1 } } });
  const chain = await prisma.fairnessChain.findUnique({ where: { id: chainId } });
  for (const s of seeds) {
    const crash = chain?.salt ? computeCrash(s.seed!, chain.salt) : 1.0;
    const r = await prisma.round.create({
      data: { seedId: s.id, nonce: 0n, crashPoint: crash, status: "running", bettingOpensAt: new Date() },
    });
    createdRoundIds.push(r.id);
  }
}

test("block-salt: cold-start random fallback, then pre-commit → arm → promote a block epoch", async () => {
  const existingActive = await prisma.fairnessChain.findFirst({ where: { status: "active" } });
  if (existingActive && existingActive.length > 8) {
    console.warn("active epoch present — skipping block-salt orchestration test (run on a clean DB / CI)");
    return;
  }
  process.env.FAIRNESS_CHAIN_LENGTH = "3";

  // Cold start: the block salt isn't ready, so play starts on a RANDOM fallback epoch.
  await fairness.ensureChain();
  const cur = await fairness.getCurrentCommit();
  expect(cur!.saltSource).toBe("random");
  const ep0 = await prisma.fairnessChain.findFirst({ where: { epoch: cur!.epoch } });
  createdChainIds.push(ep0!.id);

  // maintain() pre-commits the NEXT epoch as a PENDING block-salt epoch (future block published).
  await fairness.maintain();
  const pending = await prisma.fairnessChain.findFirst({ where: { status: "pending" } });
  expect(pending!.saltSource).toBe("eth-block");
  expect(pending!.targetBlock).not.toBeNull();
  expect(pending!.salt).toBeNull();
  createdChainIds.push(pending!.id);

  // Block not finalized yet → stays pending.
  fake.ready = false;
  await fairness.maintain();
  expect((await prisma.fairnessChain.findUnique({ where: { id: pending!.id } }))!.status).toBe("pending");

  // Block finalizes → maintain() arms it (salt set, status "armed").
  fake.ready = true;
  await fairness.maintain();
  const armed = await prisma.fairnessChain.findUnique({ where: { id: pending!.id } });
  expect(armed!.status).toBe("armed");
  expect(armed!.salt).toBe(BLOCK_HASH);

  // Exhaust the active epoch → rollover promotes the armed block-salt epoch.
  await exhaust(ep0!.id);
  const seed = await fairness.allocateSeed();
  expect(seed.chain.salt).toBe(BLOCK_HASH); // now serving the block-hash salt
  const active = await prisma.fairnessChain.findFirst({ where: { status: "active" } });
  expect(active!.id).toBe(armed!.id);
  expect(active!.saltSource).toBe("eth-block");
  expect(fairness.crashForSeed(seed)).toBe(computeCrash(seed.seed!, BLOCK_HASH));
});
