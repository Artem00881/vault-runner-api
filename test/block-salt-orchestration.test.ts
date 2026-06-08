import { test, expect, afterAll } from "bun:test";
import { PrismaService } from "../src/prisma/prisma.service";
import { FairnessService } from "../src/fairness/fairness.service";
import type { SaltProvider, SaltCommitment } from "../src/fairness/salt.provider";
import { computeCrash } from "../src/fairness/crash";
import { MetricsService } from "../src/metrics/metrics.service";
import { makeAudit } from "./helpers/audit";

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
const fairness = new FairnessService(prisma, fake, makeAudit(prisma));

// H3 metric assertion: a SECOND FairnessService wired to a scrapeable MetricsService
// (4th constructor arg). makeAudit reuses the SAME metrics so render() sees everything.
const metrics = new MetricsService();
const meteredFake = new FakeBlockProvider();
const meteredFairness = new FairnessService(prisma, meteredFake, makeAudit(prisma, metrics), metrics);

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

// ---------------------------------------------------------------------------
// H3 metric: a NON-STRICT salt-not-ready random fallback bumps
// vaultrun_fairness_salt_fallback_total{reason="salt_not_ready",mode="fallback"}.
// ---------------------------------------------------------------------------
test("metric: non-strict salt-not-ready random fallback increments vaultrun_fairness_salt_fallback_total{salt_not_ready,fallback}", async () => {
  delete process.env.FAIRNESS_REQUIRE_BLOCK_SALT; // demo / play-money: random fallback ON
  process.env.FAIRNESS_CHAIN_LENGTH = "3";
  meteredFake.ready = false; // committed block salt NOT resolvable → must fall back to random

  // Park every servable chain (remembering each one's exact original status) so
  // ensureActiveChain() reaches createEpoch(true) and hits the commit()-returns-pending →
  // salt-not-ready branch (FakeBlockProvider.commit() yields salt:null, so activate && !c.salt
  // is true → non-strict random fallback). Restored exactly at the end.
  const servable = await prisma.fairnessChain.findMany({ where: { status: { in: ["active", "armed", "pending"] } } });
  const parkedH3: { id: string; status: string }[] = servable.map((c) => ({ id: c.id, status: c.status }));
  for (const c of parkedH3) await prisma.fairnessChain.update({ where: { id: c.id }, data: { status: "test_parked_h3" } });

  // Scrape a labelled counter value out of the prom-client registry text.
  const read = async (): Promise<number> => {
    const text = await metrics.render();
    const m = text.match(
      /^vaultrun_fairness_salt_fallback_total\{[^}]*reason="salt_not_ready"[^}]*mode="fallback"[^}]*\}\s+(\d+)/m,
    );
    return m ? Number(m[1]) : 0;
  };
  const before = await read();

  const commit = await meteredFairness.ensureChain();
  expect(commit!.saltSource).toBe("random"); // transparent random fallback served
  const created = await prisma.fairnessChain.findFirst({ where: { epoch: commit!.epoch } });
  createdChainIds.push(created!.id); // FK-safe teardown by the existing afterAll

  // The metric (reason=salt_not_ready, mode=fallback) advanced by exactly one fallback event.
  expect(await read()).toBe(before + 1);

  // Restore the parked chains to their EXACT original status so other suites see the
  // original live state (don't blanket-set to active — there may be armed/pending too).
  for (const p of parkedH3) {
    await prisma.fairnessChain.update({ where: { id: p.id }, data: { status: p.status } }).catch(() => {});
  }
});
