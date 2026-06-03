import { test, expect, afterAll, beforeAll } from "bun:test";
import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { FairnessService } from "../src/fairness/fairness.service";
import { FairnessController } from "../src/fairness/fairness.controller";
import { DailySaltProvider } from "../src/fairness/salt.provider";
import { generateSeedChain } from "../src/fairness/seed-chain";
import { computeCrash, sha256Hex } from "../src/fairness/crash";

/**
 * Audit M4 — provably-fair API verifiability (regression).
 *
 * Exercises FairnessService.listEpochs / epochSeeds and the controller's
 * populated round/:id verification. Builds the service + controller directly
 * (no Nest container) and seeds FairnessChain + FairnessSeed rows from a REAL
 * generateSeedChain(n), so the SHA256 chain links actually hold.
 *
 * Case 1 is the SECURITY-CRITICAL cert-blocker: the seed dump must NEVER expose
 * an unrevealed (future) seed — that would let anyone pre-compute a future
 * round's crash.
 *
 * All rows use synthetic epochs >= 3_000_000 to avoid colliding with the live
 * fairness data on the shared dev DB (epoch is UNIQUE), and are cleaned up
 * FK-safe in afterAll (rounds → seeds → chains).
 */

const prisma = new PrismaService();
const salt = new DailySaltProvider();
const fairness = new FairnessService(prisma, salt);
const controller = new FairnessController(fairness, prisma);

// Distinct synthetic epochs per case (epoch is UNIQUE; well above live data).
const EPOCH = {
  dump: 3_000_001, // case 1 + 2 (revealed/unrevealed split, chain-of-custody)
  round: 3_000_002, // case 3 (round/:id)
  armed: 3_000_003, // case 4 (armed → salt hidden)
  exhausted: 3_000_004, // case 4 (exhausted → salt revealed)
  unrevealedRound: 3_000_005, // case 6 (revealedAt gate, not round status)
} as const;
const SYNTH_EPOCHS = Object.values(EPOCH);
const NONEXISTENT_EPOCH = 3_999_999; // case 5

const createdChainIds: string[] = [];
const createdRoundIds: string[] = [];

// A constant salt makes the recomputed crash deterministic & reproducible.
const SALT = "m4_fixed_salt_" + "ab".repeat(8);

/** Seed a full FairnessChain epoch + its FairnessSeed rows from a real chain. */
async function seedEpoch(opts: {
  epoch: number;
  status: string;
  salt: string | null;
  length: number;
  saltSource?: string;
  targetChain?: string | null;
  targetBlock?: bigint | null;
  /** chainIndexes to mark revealed (index 0 = commit is always revealed). */
  revealIndexes?: number[];
}) {
  const chainSeeds = generateSeedChain(opts.length); // chainSeeds[0] = commit
  const reveal = new Set([0, ...(opts.revealIndexes ?? [])]);
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: opts.epoch,
      commitHash: chainSeeds[0],
      length: opts.length,
      saltSource: opts.saltSource ?? "random",
      targetChain: opts.targetChain ?? null,
      targetBlock: opts.targetBlock ?? null,
      salt: opts.salt,
      status: opts.status,
      armedAt: opts.salt ? new Date() : null,
    },
  });
  createdChainIds.push(chain.id);
  await prisma.fairnessSeed.createMany({
    data: chainSeeds.map((seed, idx) => ({
      chainId: chain.id,
      chainIndex: idx,
      seedHash: sha256Hex(seed),
      seed,
      revealedAt: reveal.has(idx) ? new Date() : null,
    })),
  });
  return { chain, chainSeeds };
}

beforeAll(async () => {
  // Pre-flight: ensure no stale synthetic rows from a previous aborted run.
  const stale = await prisma.fairnessChain.findMany({ where: { epoch: { in: SYNTH_EPOCHS } } });
  if (stale.length) {
    const ids = stale.map((c) => c.id);
    await prisma.round.deleteMany({ where: { seed: { chainId: { in: ids } } } });
    await prisma.fairnessSeed.deleteMany({ where: { chainId: { in: ids } } });
    await prisma.fairnessChain.deleteMany({ where: { id: { in: ids } } });
  }
});

afterAll(async () => {
  // FK-safe teardown: rounds → seeds → chains. Never fail the suite on cleanup.
  try {
    if (createdRoundIds.length)
      await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdChainIds.length) {
      await prisma.round.deleteMany({ where: { seed: { chainId: { in: createdChainIds } } } });
      await prisma.fairnessSeed.deleteMany({ where: { chainId: { in: createdChainIds } } });
      await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    }
    // Belt-and-suspenders: nuke anything left under our synthetic epoch range.
    const leftover = await prisma.fairnessChain.findMany({ where: { epoch: { in: SYNTH_EPOCHS } } });
    if (leftover.length) {
      const ids = leftover.map((c) => c.id);
      await prisma.round.deleteMany({ where: { seed: { chainId: { in: ids } } } });
      await prisma.fairnessSeed.deleteMany({ where: { chainId: { in: ids } } });
      await prisma.fairnessChain.deleteMany({ where: { id: { in: ids } } });
    }
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Case 1 — SECURITY-CRITICAL: the seed dump NEVER returns an unrevealed seed.
// ---------------------------------------------------------------------------
test("SECURITY: epochSeeds never exposes an unrevealed (future) seed", async () => {
  // Chain of 8; reveal indices 0..4, leave 5,6,7 unrevealed (future rounds).
  const { chainSeeds } = await seedEpoch({
    epoch: EPOCH.dump,
    status: "active",
    salt: SALT,
    length: 8,
    revealIndexes: [1, 2, 3, 4],
  });

  const out = await fairness.epochSeeds(EPOCH.dump);
  expect(out).not.toBeNull();

  // Exactly indices 0..4 are present, in order; revealedCount === 5.
  expect(out!.revealedCount).toBe(5);
  expect(out!.seeds.map((s) => s.chainIndex)).toEqual([0, 1, 2, 3, 4]);

  // The unrevealed indices 5,6,7 are absent from the dump entirely.
  const dumpedIndexes = new Set(out!.seeds.map((s) => s.chainIndex));
  expect(dumpedIndexes.has(5)).toBe(false);
  expect(dumpedIndexes.has(6)).toBe(false);
  expect(dumpedIndexes.has(7)).toBe(false);

  // CORE SECURITY ASSERTION: the raw seed bytes of every future (unrevealed)
  // seed appear NOWHERE in the serialized response. SHA256 is one-way, so the
  // revealed prefix must disclose nothing about seeds 5,6,7. A regression that
  // dropped the `revealedAt` filter would leak these and fail here.
  const json = JSON.stringify(out);
  for (const idx of [5, 6, 7]) {
    const futureSeed = chainSeeds[idx];
    expect(json.includes(futureSeed)).toBe(false);
  }
  // Sanity: a revealed seed IS present (the dump isn't trivially empty).
  expect(json.includes(chainSeeds[4])).toBe(true);
});

// ---------------------------------------------------------------------------
// Case 2 — Chain-of-custody reconstructs from the dumped revealed seeds.
// ---------------------------------------------------------------------------
test("chain-of-custody: dumped revealed seeds chain back to the commit", async () => {
  const out = await fairness.epochSeeds(EPOCH.dump); // reuse the epoch from case 1
  expect(out).not.toBeNull();
  const seeds = out!.seeds;
  expect(seeds.length).toBeGreaterThanOrEqual(2);

  // For each i >= 1: SHA256(seed[i]) === seed[i-1]  (the published chain link).
  for (let i = 1; i < seeds.length; i++) {
    expect(sha256Hex(seeds[i].seed!)).toBe(seeds[i - 1].seed!);
    // And each row's stored seedHash equals SHA256(seed) (consistent commit).
    expect(seeds[i].seedHash).toBe(sha256Hex(seeds[i].seed!));
  }

  // seed[0] is the published commit; its hash links to nothing above it but its
  // own seedHash must be self-consistent.
  expect(seeds[0].chainIndex).toBe(0);
  expect(seeds[0].seed).toBe(out!.commitHash);
  expect(seeds[0].seedHash).toBe(sha256Hex(seeds[0].seed!));
  // And seed[1] hashes to the commit (chains all the way back to seed[0]).
  expect(sha256Hex(seeds[1].seed!)).toBe(out!.commitHash);
});

// ---------------------------------------------------------------------------
// Case 3 — round/:id populates linkVerified + the epoch fields.
// ---------------------------------------------------------------------------
test("round/:id returns epoch fields, matches:true and linkVerified:true", async () => {
  // Seed a chain; pick a revealed round at chainIndex k >= 1 with its k-1 present.
  const K = 3;
  const { chain, chainSeeds } = await seedEpoch({
    epoch: EPOCH.round,
    status: "exhausted", // salt public so verify() runs
    salt: SALT,
    length: 6,
    saltSource: "eth-block",
    targetChain: "ethereum",
    targetBlock: 25_000_000n,
    revealIndexes: [1, 2, 3], // index K=3 revealed, predecessor K-1=2 revealed
  });

  const seedRow = await prisma.fairnessSeed.findFirst({
    where: { chainId: chain.id, chainIndex: K },
  });
  expect(seedRow).not.toBeNull();

  // crashPoint stored = the real computed crash, so matches must be true.
  const crash = computeCrash(chainSeeds[K], SALT);
  const round = await prisma.round.create({
    data: {
      seedId: seedRow!.id,
      nonce: 0n,
      crashPoint: crash,
      status: "completed", // in REVEALED set
      bettingOpensAt: new Date(),
    },
  });
  createdRoundIds.push(round.id);

  const res: any = await controller.round(round.id);

  expect(res.revealed).toBe(true);
  // Epoch / salt-source fields surfaced by M4.
  expect(res.epoch).toBe(EPOCH.round);
  expect(res.commitHash).toBe(chainSeeds[0]);
  expect(res.saltSource).toBe("eth-block");
  expect(res.targetChain).toBe("ethereum");
  expect(res.targetBlock).toBe(25_000_000);
  expect(res.chainIndex).toBe(K);
  // prevSeed = seed at K-1; the chain link must verify.
  expect(res.prevSeed).toBe(chainSeeds[K - 1]);
  expect(sha256Hex(res.seed)).toBe(res.prevSeed); // SHA256(seed_k) === seed_{k-1}

  // Recomputed crash matches the stored one.
  expect(res.recomputedCrash).toBe(crash);
  expect(res.matches).toBe(true);
  // The populated link verification (pre-M4 this was always null).
  expect(res.linkVerified).toBe(true);
});

// ---------------------------------------------------------------------------
// Case 4 — listEpochs exposes raw salt only for active/exhausted.
// ---------------------------------------------------------------------------
test("listEpochs reveals raw salt only for active/exhausted, never for armed/pending", async () => {
  const ARMED_SALT = "armed_salt_" + "cd".repeat(8);
  const EXHAUSTED_SALT = "exhausted_salt_" + "ef".repeat(8);
  await seedEpoch({ epoch: EPOCH.armed, status: "armed", salt: ARMED_SALT, length: 4 });
  await seedEpoch({ epoch: EPOCH.exhausted, status: "exhausted", salt: EXHAUSTED_SALT, length: 4 });

  const all = await fairness.listEpochs();
  const armed = all.find((e) => e.epoch === EPOCH.armed);
  const exhausted = all.find((e) => e.epoch === EPOCH.exhausted);
  expect(armed).toBeDefined();
  expect(exhausted).toBeDefined();

  // Exhausted (has served rounds) → raw salt revealed.
  expect(exhausted!.salt).toBe(EXHAUSTED_SALT);
  // Armed (future epoch, not yet serving) → raw salt withheld...
  expect(armed!.salt).toBeNull();
  // ...but BOTH publish the salt commitment hash (so the future salt is bound).
  expect(armed!.saltHash).not.toBeNull();
  expect(exhausted!.saltHash).not.toBeNull();
  // saltHash for the armed epoch is the SHA256 of its (still-hidden) salt.
  const { createHash } = await import("node:crypto");
  expect(armed!.saltHash).toBe(createHash("sha256").update(ARMED_SALT, "utf8").digest("hex"));

  // epochSeeds mirrors the same rule: armed epoch's raw salt stays null.
  const armedSeeds = await fairness.epochSeeds(EPOCH.armed);
  expect(armedSeeds!.salt).toBeNull();
  const exhaustedSeeds = await fairness.epochSeeds(EPOCH.exhausted);
  expect(exhaustedSeeds!.salt).toBe(EXHAUSTED_SALT);
});

// ---------------------------------------------------------------------------
// Case 5 — epochSeeds(nonexistent) → null; controller maps to 404.
// ---------------------------------------------------------------------------
test("epochSeeds(nonexistent) returns null and the controller throws NotFoundException", async () => {
  const out = await fairness.epochSeeds(NONEXISTENT_EPOCH);
  expect(out).toBeNull();

  await expect(controller.epochSeeds(String(NONEXISTENT_EPOCH))).rejects.toBeInstanceOf(
    NotFoundException,
  );
});

// ---------------------------------------------------------------------------
// Case 6 — round/:id reveal gate is the SEED's revealedAt, NOT the round status
// (audit M4 LOW-1). A restart-VOIDED round can be forced to a terminal status
// ('completed') WITHOUT its seed ever being revealed (recoverInterruptedRounds
// sets the round 'completed' but never calls revealSeed). The OLD status-gate
// (REVEALED.has(round.status)) would then have DISCLOSED that round's seed/salt/
// recomputedCrash, while /epoch/:epoch/seeds (revealedAt gate) would NOT list it.
// The fix makes round/:id agree: disclosure iff seed.revealedAt != null.
// FAILS-FIRST under the old status-gate (a 'completed' round with an unrevealed
// seed would return revealed:true and leak `seed`).
// ---------------------------------------------------------------------------
test("round/:id gates disclosure on seed.revealedAt, not round status", async () => {
  // Chain of 6; reveal only index 0 (commit). Index K=3 is left UNREVEALED,
  // simulating a restart-voided round whose seed was never disclosed.
  const K = 3;
  const { chain, chainSeeds } = await seedEpoch({
    epoch: EPOCH.unrevealedRound,
    status: "active",
    salt: SALT,
    length: 6,
    // revealIndexes omitted → only index 0 revealed; index K stays revealedAt: null.
  });

  const seedRow = await prisma.fairnessSeed.findFirst({
    where: { chainId: chain.id, chainIndex: K },
  });
  expect(seedRow).not.toBeNull();
  // Precondition: the seed at K is genuinely unrevealed.
  expect(seedRow!.revealedAt).toBeNull();

  // Round forced to a "revealed-looking" terminal status, but its seed is unrevealed.
  const crash = computeCrash(chainSeeds[K], SALT);
  const round = await prisma.round.create({
    data: {
      seedId: seedRow!.id,
      nonce: 0n,
      crashPoint: crash,
      status: "completed", // terminal status — would pass the OLD REVEALED.has() gate
      bettingOpensAt: new Date(),
    },
  });
  createdRoundIds.push(round.id);

  // --- Unrevealed seed: NO disclosure, regardless of the 'completed' status. ---
  const hidden: any = await controller.round(round.id);
  expect(hidden.revealed).toBe(false);
  expect(hidden.roundId).toBe(round.id);
  expect(hidden.status).toBe("completed");
  // The reveal payload must be entirely absent (no leak of seed/salt/recompute).
  expect(hidden.seed).toBeUndefined();
  expect(hidden.salt).toBeUndefined();
  expect(hidden.recomputedCrash).toBeUndefined();
  expect(hidden.prevSeed).toBeUndefined();
  expect(hidden.epoch).toBeUndefined();
  // Belt-and-suspenders: the raw seed bytes appear NOWHERE in the response.
  expect(JSON.stringify(hidden).includes(chainSeeds[K])).toBe(false);

  // --- Flip the seed to revealed → the SAME round now discloses. ---
  await prisma.fairnessSeed.update({
    where: { id: seedRow!.id },
    data: { revealedAt: new Date() },
  });

  const shown: any = await controller.round(round.id);
  expect(shown.revealed).toBe(true);
  expect(shown.seed).toBe(chainSeeds[K]);
  expect(shown.salt).toBe(SALT);
  expect(shown.epoch).toBe(EPOCH.unrevealedRound);
  // Recomputed crash matches the stored one (and prevSeed/link verify).
  expect(shown.recomputedCrash).toBe(crash);
  expect(shown.matches).toBe(true);
  expect(shown.prevSeed).toBe(chainSeeds[K - 1]);
  expect(sha256Hex(shown.seed)).toBe(shown.prevSeed);
  expect(shown.linkVerified).toBe(true);
});
