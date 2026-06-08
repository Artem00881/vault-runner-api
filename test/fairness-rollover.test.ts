import { test, expect, afterAll, beforeAll } from "bun:test";
import { PrismaService } from "../src/prisma/prisma.service";
import { FairnessService } from "../src/fairness/fairness.service";
import { DailySaltProvider } from "../src/fairness/salt.provider";
import { computeCrash, sha256Hex } from "../src/fairness/crash";
import { makeAudit } from "./helpers/audit";

const prisma = new PrismaService();
const fairness = new FairnessService(prisma, new DailySaltProvider(), makeAudit(prisma));

const createdRoundIds: string[] = [];
const createdChainIds: string[] = [];

// F-072: a per-suite sentinel status used to PARK all servable chains so the isolated
// variant runs the real rollover flow against an empty servable state on a dirty DB
// (mirrors the H3 park pattern in block-salt-orchestration.test.ts). Restored in afterAll.
const PARK = "test_parked_rollover";
const parked: { id: string; status: string }[] = [];

async function activeEpochExists(): Promise<boolean> {
  const a = await prisma.fairnessChain.findFirst({ where: { status: "active" } });
  return !!(a && a.length > 8);
}

/** Park every servable (active|armed|pending) chain so ensureActiveChain() sees none
 *  servable and must cold-start a fresh epoch. Remembers each one's exact status. */
async function parkServable() {
  const servable = await prisma.fairnessChain.findMany({ where: { status: { in: ["active", "armed", "pending"] } } });
  for (const c of servable) {
    parked.push({ id: c.id, status: c.status });
    await prisma.fairnessChain.update({ where: { id: c.id }, data: { status: PARK } });
  }
}

async function restoreParked() {
  for (const p of parked) {
    await prisma.fairnessChain.update({ where: { id: p.id }, data: { status: p.status } }).catch(() => {});
  }
  parked.length = 0;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  try {
    await restoreParked(); // belt-and-braces if a test threw before restoring
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

// Resolve the dirty-DB gate ONCE at module load (top-level await) so test.skipIf can
// read it synchronously. On a clean DB / CI this is false and the original test RUNS;
// on a dirty dev DB with a real large active epoch it's an HONEST skip (was: a vacuous
// early-`return` that passed with 0 assertions — F-072). The ISOLATED variant below
// ALWAYS runs regardless (it parks the live state first), so the rollover behaviour is
// exercised on EVERY run.
const ACTIVE_EPOCH_EXISTS = await activeEpochExists();

/** The core cold-start → exhaust → rollover assertions, shared by both variants. They
 *  must be run when ensureActiveChain() will cold-start a FRESH active epoch (clean DB,
 *  or after parkServable()). Returns nothing; pushes created ids for teardown. */
async function assertExhaustionRollsOver() {
  process.env.FAIRNESS_CHAIN_LENGTH = "3"; // tiny epochs: seeds [0,1,2]; only 1,2 are playable

  // --- Epoch A --- (length comes from FAIRNESS_CHAIN_LENGTH set above)
  await fairness.ensureChain();
  const a = await fairness.getCurrentCommit();
  expect(a).not.toBeNull();
  const chainA = await prisma.fairnessChain.findFirst({ where: { epoch: a!.epoch } });
  createdChainIds.push(chainA!.id);

  // Exhaust epoch A — allocate + use its two playable seeds (indices 1, 2).
  const s1 = await fairness.allocateSeed();
  expect(typeof s1!.chain.salt).toBe("string");
  await useSeed(s1!);
  const s2 = await fairness.allocateSeed();
  await useSeed(s2!);

  // --- Next allocate must ROLL OVER to a new epoch (no exhaustion stall) ---
  const s3 = await fairness.allocateSeed();
  expect(s3).not.toBeNull(); // a non-strict fallback never stalls
  const chainB = await prisma.fairnessChain.findUnique({ where: { id: s3!.chainId } });
  expect(chainB).not.toBeNull();
  if (!createdChainIds.includes(chainB!.id)) createdChainIds.push(chainB!.id);
  await useSeed(s3!);

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
}

// HONEST SKIP on a dirty DB (was a vacuous early-return). Runs on a clean DB / CI.
test.skipIf(ACTIVE_EPOCH_EXISTS)("active epoch exhaustion rolls over to a fresh epoch (no stall)", async () => {
  await assertExhaustionRollsOver();
});

// UNCONDITIONAL DB-isolated variant (F-072): parks any live servable epoch so the
// service cold-starts a fresh one, then ALWAYS asserts exhaustion → auto-rollover (no
// stall). This exercises the rollover on EVERY run, even on the dirty dev DB.
test("active epoch exhaustion rolls over to a fresh epoch (no stall) [isolated]", async () => {
  await parkServable();
  try {
    await assertExhaustionRollsOver();
  } finally {
    await restoreParked();
  }
});
