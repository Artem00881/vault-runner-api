import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { PrismaService } from "../src/prisma/prisma.service";
import { FairnessService } from "../src/fairness/fairness.service";
import { makeSaltProvider } from "../src/fairness/fairness.module";
import { DailySaltProvider, EthBlockSaltProvider } from "../src/fairness/salt.provider";
import type { SaltProvider, SaltCommitment } from "../src/fairness/salt.provider";
import { generateSeedChain } from "../src/fairness/seed-chain";
import { sha256Hex } from "../src/fairness/crash";
import { makeAudit } from "./helpers/audit";

/**
 * Audit M6 regression: in real-money mode (FAIRNESS_REQUIRE_BLOCK_SALT=true) the
 * engine must NEVER open rounds on a grindable random-salt fallback nor orphan a
 * pre-committed block epoch — it STALLS until the committed block salt resolves.
 * Default (flag unset) keeps the demo/play-money random fallback (no regression).
 *
 * These exercise FairnessService.allocateSeed / createEpoch / ensureActiveChain and
 * the fairness_chains rows directly (no engine loop required).
 *
 * Isolation: synthetic epochs live at >= SYNTH_BASE (3,000,000) so they never touch
 * the real epoch 0 / live chain. Any pre-existing real SERVABLE chain (active/armed/
 * pending) is parked to a non-servable sentinel for the duration so createEpoch is
 * actually reached, then restored exactly. FK-safe teardown: rounds -> seeds -> chains.
 */

const prisma = new PrismaService();

const BLOCK_HASH = "0x" + "ab".repeat(32); // a fixed "finalized block hash"

/**
 * Controllable block-salt-like provider. commit() always returns a pending block
 * commitment (salt:null + a future targetBlock). resolve() yields the block hash only
 * once `ready` is toggled. `failCommit` lets a test simulate the oracle being down at
 * commit time (the other strict branch). Mirrors block-salt-orchestration.test.ts.
 */
class FakeBlockProvider implements SaltProvider {
  readonly source = "eth-block";
  ready = false;
  failCommit = false;
  private block = 1_000_000;
  async commit(): Promise<SaltCommitment> {
    if (this.failCommit) throw new Error("oracle down (test)");
    this.block += 1000;
    return { source: "eth-block", salt: null, targetChain: "ethereum", targetBlock: this.block };
  }
  async resolve(c: SaltCommitment): Promise<string | null> {
    if (c.salt) return c.salt;
    return this.ready ? BLOCK_HASH : null;
  }
}

const fake = new FakeBlockProvider();
const fairness = new FairnessService(prisma, fake, makeAudit(prisma));

const SYNTH_BASE = 3_000_000; // synthetic epoch floor — never collides with live chains

/** Real servable chains we parked, with their original status to restore. */
const parked: { id: string; status: string }[] = [];

/**
 * FK-safe purge of EVERY synthetic chain (epoch >= SYNTH_BASE) and its seeds/rounds.
 * Range-based (not ID-tracked) so it also removes chains the SERVICE minted via
 * createEpoch (random fallback / promoted epochs) — those have no app-side handle.
 * Never touches the real epoch 0 / live chains (all < SYNTH_BASE).
 */
async function purgeSynthetic() {
  const chains = await prisma.fairnessChain.findMany({
    where: { epoch: { gte: SYNTH_BASE } },
    select: { id: true },
  });
  if (chains.length === 0) return;
  const ids = chains.map((c) => c.id);
  await prisma.round.deleteMany({ where: { seed: { chainId: { in: ids } } } });
  await prisma.fairnessSeed.deleteMany({ where: { chainId: { in: ids } } });
  await prisma.fairnessChain.deleteMany({ where: { id: { in: ids } } });
}

const ENV_KEY = "FAIRNESS_REQUIRE_BLOCK_SALT";
const ENV_LEN = "FAIRNESS_CHAIN_LENGTH";
const ENV_PROVIDER = "SALT_PROVIDER_TYPE"; // mutated by the H1 makeSaltProvider() cases
const savedEnv = process.env[ENV_KEY];
const savedLen = process.env[ENV_LEN];
const savedProvider = process.env[ENV_PROVIDER];

/** Set or delete an env var (undefined => delete). */
function setEnv(key: string, val: string | undefined) {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

/** Insert a synthetic chain + its seed chain directly (bypasses the service). */
async function seedChain(opts: {
  epoch: number;
  status: string;
  saltSource: string;
  salt: string | null;
  length: number;
  targetChain?: string | null;
  targetBlock?: number | null;
}) {
  const seeds = generateSeedChain(opts.length); // seeds[0] = public commit
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: opts.epoch,
      commitHash: seeds[0],
      length: opts.length,
      saltSource: opts.saltSource,
      targetChain: opts.targetChain ?? null,
      targetBlock: opts.targetBlock ?? null,
      salt: opts.salt,
      status: opts.status,
      armedAt: opts.salt ? new Date() : null,
    },
  });
  await prisma.fairnessSeed.createMany({
    data: seeds.map((seed, idx) => ({
      chainId: chain.id,
      chainIndex: idx,
      seedHash: sha256Hex(seed),
      seed,
      revealedAt: idx === 0 ? new Date() : null,
    })),
  });
  return chain;
}

/** Consume every seed at index >= 1 of a chain by creating a round per seed (exhausts it). */
async function exhaust(chainId: string) {
  const seeds = await prisma.fairnessSeed.findMany({ where: { chainId, chainIndex: { gte: 1 } } });
  for (const s of seeds) {
    await prisma.round.create({
      data: { seedId: s.id, nonce: 0n, crashPoint: 1.0, status: "running", bettingOpensAt: new Date() },
    });
  }
}

/** Current global max epoch (used to assert monotonicity / no-new-epoch). */
async function maxEpoch(): Promise<number> {
  const agg = await prisma.fairnessChain.aggregate({ _max: { epoch: true } });
  return agg._max.epoch ?? -1;
}

async function countSynthChains(): Promise<number> {
  return prisma.fairnessChain.count({ where: { epoch: { gte: SYNTH_BASE } } });
}

beforeAll(async () => {
  // Self-heal: a prior crashed run could have left synthetic chains behind — purge them
  // so this suite starts from a known state (only the real epoch 0 / live chains remain).
  await purgeSynthetic();
  // Park any real SERVABLE chain so findActive()/armed/pending lookups don't short-circuit
  // createEpoch. No local engine is running (server down), so this is momentary + restored.
  const servable = await prisma.fairnessChain.findMany({
    where: { status: { in: ["active", "armed", "pending"] }, epoch: { lt: SYNTH_BASE } },
  });
  for (const c of servable) {
    parked.push({ id: c.id, status: c.status });
    await prisma.fairnessChain.update({ where: { id: c.id }, data: { status: "test_parked" } });
  }
});

// Strict flag + provider type are per-test; always restore so one test can't leak
// into the next (H1 cases mutate SALT_PROVIDER_TYPE; every case may set strict).
afterEach(() => {
  setEnv(ENV_KEY, savedEnv);
  setEnv(ENV_PROVIDER, savedProvider);
});

afterAll(async () => {
  try {
    // Delete EVERY synthetic chain (incl. service-minted fallback/promoted epochs).
    await purgeSynthetic();
    // Restore the parked real chains to their exact original status.
    for (const p of parked) {
      await prisma.fairnessChain
        .update({ where: { id: p.id }, data: { status: p.status } })
        .catch(() => {});
    }
  } catch {
    // never fail the suite on cleanup
  } finally {
    // Restore env exactly.
    setEnv(ENV_KEY, savedEnv);
    setEnv(ENV_LEN, savedLen);
    setEnv(ENV_PROVIDER, savedProvider);
  }
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Case 1: STRICT + block salt NOT ready -> STALL, NO epoch created (fails-first).
// ---------------------------------------------------------------------------
test("STRICT + block salt not ready -> allocateSeed null, no random epoch minted", async () => {
  process.env[ENV_KEY] = "true";
  process.env[ENV_LEN] = "4";
  fake.ready = false;
  fake.failCommit = false;

  // Anchor the epoch counter high so any createEpoch would land at >= SYNTH_BASE+1.
  await seedChain({ epoch: SYNTH_BASE, status: "exhausted", saltSource: "eth-block", salt: BLOCK_HASH, length: 4 });
  const before = await countSynthChains();

  const seed = await fairness.allocateSeed();
  expect(seed).toBeNull(); // STALL: committed block salt not resolved, no grindable fallback

  // No new chain row was created (no random "active" epoch, no orphan).
  expect(await countSynthChains()).toBe(before);
  // Specifically: nothing minted beyond the anchor epoch.
  expect(await maxEpoch()).toBe(SYNTH_BASE);
});

// ---------------------------------------------------------------------------
// Case 2: STRICT + block salt ready -> the pre-committed block epoch arms, promotes
// to active, and serves (block source, not random).
// ---------------------------------------------------------------------------
test("STRICT + block salt ready -> pending block epoch arms+promotes to active and serves a seed", async () => {
  process.env[ENV_KEY] = "true";
  process.env[ENV_LEN] = "4";
  fake.failCommit = false;

  // No active epoch (case 1 only minted nothing); seed a PENDING block epoch whose
  // committed block is not finalized yet (salt:null).
  fake.ready = false;
  const pendingEpoch = (await maxEpoch()) + 1;
  const pending = await seedChain({
    epoch: pendingEpoch,
    status: "pending",
    saltSource: "eth-block",
    salt: null,
    targetChain: "ethereum",
    targetBlock: 98_000_000,
    length: 4,
  });

  // Block now finalizes -> resolve() yields the hash. allocateSeed()->ensureActiveChain
  // arms the pending epoch (salt set) and promotes it to active, then serves a seed.
  fake.ready = true;
  const seed = await fairness.allocateSeed();
  expect(seed).not.toBeNull();
  expect(seed!.chain.salt).toBe(BLOCK_HASH); // serving the block-hash salt, not random

  const active = await prisma.fairnessChain.findUnique({ where: { id: pending.id } });
  expect(active!.status).toBe("active"); // the same pre-committed epoch promoted
  expect(active!.saltSource).toBe("eth-block");
  expect(active!.salt).toBe(BLOCK_HASH);
  expect(active!.epoch).toBe(pendingEpoch);
});

// ---------------------------------------------------------------------------
// Case 3: STRICT rollover doesn't orphan the pending block epoch / stays monotonic.
// ---------------------------------------------------------------------------
test("STRICT rollover: exhausted active + pending block epoch -> stall, no skipped/orphan epoch, then same pending promotes", async () => {
  process.env[ENV_KEY] = "true";
  process.env[ENV_LEN] = "4";
  fake.ready = false;
  fake.failCommit = false;

  // Drop the prior test's active epoch out of the servable set so this scenario is clean.
  await prisma.fairnessChain.updateMany({
    where: { status: "active", epoch: { gte: SYNTH_BASE } },
    data: { status: "test_parked" },
  });

  // A short ACTIVE epoch (known random salt, exhaustible) + the NEXT epoch as a
  // PENDING block epoch whose salt is not ready yet.
  const activeEpoch = (await maxEpoch()) + 1;
  const pendingEpoch = activeEpoch + 1;
  const active = await seedChain({
    epoch: activeEpoch,
    status: "active",
    saltSource: "random",
    salt: "f0".repeat(32),
    length: 3, // seeds[1], seeds[2] -> exhausts after 2 rounds
  });
  const pending = await seedChain({
    epoch: pendingEpoch,
    status: "pending",
    saltSource: "eth-block",
    salt: null,
    targetChain: "ethereum",
    targetBlock: 99_000_000,
    length: 4,
  });

  await exhaust(active.id); // consume every servable seed of the active epoch
  const maxBefore = await maxEpoch();

  // Rollover under strict with the next (block) salt unresolved -> STALL.
  const seed = await fairness.allocateSeed();
  expect(seed).toBeNull();

  // The active epoch was marked exhausted (rollover was attempted)...
  expect((await prisma.fairnessChain.findUnique({ where: { id: active.id } }))!.status).toBe("exhausted");
  // ...but NO new epoch was minted beyond the pending one (pending not skipped/orphaned;
  // no random "active" epoch appeared). Max epoch is unchanged.
  expect(await maxEpoch()).toBe(maxBefore);
  const stray = await prisma.fairnessChain.findFirst({
    where: { status: "active", epoch: { gte: SYNTH_BASE } },
  });
  expect(stray).toBeNull(); // nothing is serving — correctly stalled
  // The pending block epoch is untouched (still pending, still no salt).
  const pendingAfter = await prisma.fairnessChain.findUnique({ where: { id: pending.id } });
  expect(pendingAfter!.status).toBe("pending");
  expect(pendingAfter!.salt).toBeNull();

  // Now the committed block finalizes -> maintain() arms the SAME pending epoch.
  fake.ready = true;
  await fairness.maintain();
  const armed = await prisma.fairnessChain.findUnique({ where: { id: pending.id } });
  expect(armed!.status).toBe("armed");
  expect(armed!.salt).toBe(BLOCK_HASH);

  // allocateSeed() promotes that same epoch (monotonic — no epoch was skipped) and serves.
  const seed2 = await fairness.allocateSeed();
  expect(seed2).not.toBeNull();
  expect(seed2!.chain.salt).toBe(BLOCK_HASH);
  const nowActive = await prisma.fairnessChain.findFirst({ where: { status: "active", epoch: { gte: SYNTH_BASE } } });
  expect(nowActive!.id).toBe(pending.id); // the pre-committed epoch itself promoted
  expect(nowActive!.epoch).toBe(pendingEpoch);
});

// ---------------------------------------------------------------------------
// Case 4: DEFAULT (flag unset) still falls back to random -> no regression.
// ---------------------------------------------------------------------------
test("DEFAULT (flag unset) + block salt not ready -> random fallback active epoch is created and serves", async () => {
  delete process.env[ENV_KEY]; // not real-money mode
  process.env[ENV_LEN] = "4";
  fake.ready = false; // block salt unavailable
  fake.failCommit = false;

  // Park any active synth epoch so ensureActiveChain must create a fresh one.
  await prisma.fairnessChain.updateMany({
    where: { status: { in: ["active", "armed", "pending"] }, epoch: { gte: SYNTH_BASE } },
    data: { status: "test_parked" },
  });

  const before = await maxEpoch();
  const seed = await fairness.allocateSeed();
  expect(seed).not.toBeNull(); // play continues on the demo path

  const active = await prisma.fairnessChain.findFirst({
    where: { status: "active", epoch: { gte: SYNTH_BASE } },
    orderBy: { epoch: "desc" },
  });
  expect(active).not.toBeNull();
  expect(active!.saltSource).toBe("random"); // transparent random fallback
  expect(active!.salt).not.toBeNull();
  expect(active!.epoch).toBeGreaterThan(before);
});

// ===========================================================================
// H1 — fail CLOSED at boot. makeSaltProvider() (pure) must THROW when strict is
// on but the configured provider is not eth-block (a random PRIMARY salt is just
// as grindable as the fallback, so the strict guard would be silently inert).
// No DB needed. Env is restored by afterEach (ENV_KEY + ENV_PROVIDER).
// ===========================================================================
type ProviderCase = {
  name: string;
  strict: string | undefined; // FAIRNESS_REQUIRE_BLOCK_SALT
  providerType: string | undefined; // SALT_PROVIDER_TYPE
  throws: boolean;
  instanceOf?: unknown;
};

const providerCases: ProviderCase[] = [
  {
    name: "strict + provider=random -> THROWS (guard would be inert on a grindable primary)",
    strict: "true",
    providerType: "random",
    throws: true,
  },
  {
    name: "strict + provider unset -> THROWS (default DailySaltProvider is grindable)",
    strict: "true",
    providerType: undefined,
    throws: true,
  },
  {
    name: "strict + provider=eth-block -> OK, returns EthBlockSaltProvider",
    strict: "true",
    providerType: "eth-block",
    throws: false,
    instanceOf: EthBlockSaltProvider,
  },
  {
    name: "default (strict unset) + provider=random -> OK, returns DailySaltProvider",
    strict: undefined,
    providerType: "random",
    throws: false,
    instanceOf: DailySaltProvider,
  },
  {
    name: "default (strict unset) + provider unset -> OK, returns DailySaltProvider",
    strict: undefined,
    providerType: undefined,
    throws: false,
    instanceOf: DailySaltProvider,
  },
];

for (const tc of providerCases) {
  test(`H1 makeSaltProvider: ${tc.name}`, () => {
    setEnv(ENV_KEY, tc.strict);
    setEnv(ENV_PROVIDER, tc.providerType);

    if (tc.throws) {
      // Fail-closed: a strict-but-random config must not boot.
      expect(() => makeSaltProvider()).toThrow(/requires SALT_PROVIDER_TYPE=eth-block/);
    } else {
      const provider = makeSaltProvider();
      expect(provider).toBeInstanceOf(tc.instanceOf as never);
    }
  });
}

// ===========================================================================
// M1 — retire a non-block ACTIVE/ARMED epoch under strict. Flipping strict on
// over a live RANDOM chain must NOT serve up to a full chain of grindable rounds:
// ensureActiveChain RETIRES the random active/armed epoch (-> exhausted + WARN)
// and rolls to a block epoch (or stalls until one is armed).
// ===========================================================================

// --- M1a: strict + RANDOM active epoch, no block epoch -> retire + STALL. ---
// FAILS-FIRST: without M1, ensureActiveChain returns the random "active" epoch and
// allocateSeed() serves one of its (grindable) seeds instead of retiring + stalling.
test("M1 strict: pre-existing RANDOM active epoch is retired (exhausted) and NOT served -> stall", async () => {
  process.env[ENV_KEY] = "true";
  process.env[ENV_LEN] = "4";
  fake.ready = false; // no block salt available -> nothing to roll to
  fake.failCommit = false;

  // Park any leftover servable synth epoch (prior cases mint random/block ones) so the
  // RANDOM epoch we seed below is the SOLE servable chain ensureActiveChain can pick.
  await prisma.fairnessChain.updateMany({
    where: { status: { in: ["active", "armed", "pending"] }, epoch: { gte: SYNTH_BASE } },
    data: { status: "test_parked" },
  });

  // A live RANDOM active epoch with a real salt and UNUSED seeds (would be servable).
  const randomEpoch = (await maxEpoch()) + 1;
  const random = await seedChain({
    epoch: randomEpoch,
    status: "active",
    saltSource: "random",
    salt: "a1".repeat(32),
    length: 4, // seeds[1..3] all unused
  });
  const maxBefore = await maxEpoch();

  const seed = await fairness.allocateSeed();
  expect(seed).toBeNull(); // STALL: random epoch refused, no block epoch armed

  // The random epoch was RETIRED (not served).
  const after = await prisma.fairnessChain.findUnique({ where: { id: random.id } });
  expect(after!.status).toBe("exhausted");
  // No grindable epoch is serving, and no new random "active" epoch was minted.
  const stray = await prisma.fairnessChain.findFirst({
    where: { status: "active", epoch: { gte: SYNTH_BASE } },
  });
  expect(stray).toBeNull();
  expect(await maxEpoch()).toBe(maxBefore); // no orphan/skip
});

// --- M1b: strict + RANDOM armed epoch -> retired (not promoted); a block epoch serves. ---
test("M1 strict: RANDOM armed epoch is retired (not promoted); a resolved block epoch serves instead", async () => {
  process.env[ENV_KEY] = "true";
  process.env[ENV_LEN] = "4";
  fake.failCommit = false;

  // Clear any leftover servable synth epoch so the only servable chains are the two we seed.
  await prisma.fairnessChain.updateMany({
    where: { status: { in: ["active", "armed", "pending"] }, epoch: { gte: SYNTH_BASE } },
    data: { status: "test_parked" },
  });

  // A RANDOM armed epoch (lower) + a PENDING block epoch (higher). retireChain takes the
  // random armed off the board; the block epoch's salt then resolves and serves instead.
  const armedEpoch = (await maxEpoch()) + 1;
  const blockEpoch = armedEpoch + 1;
  const randomArmed = await seedChain({
    epoch: armedEpoch,
    status: "armed",
    saltSource: "random",
    salt: "b2".repeat(32),
    length: 4,
  });
  const block = await seedChain({
    epoch: blockEpoch,
    status: "pending",
    saltSource: "eth-block",
    salt: null,
    targetChain: "ethereum",
    targetBlock: 97_500_000,
    length: 4,
  });

  fake.ready = true; // block now finalized -> resolve() yields BLOCK_HASH
  const seed = await fairness.allocateSeed();
  expect(seed).not.toBeNull();
  expect(seed!.chain.salt).toBe(BLOCK_HASH); // served the block-hash salt, NOT the random armed one

  // The random armed epoch was retired (never promoted to active).
  const armedAfter = await prisma.fairnessChain.findUnique({ where: { id: randomArmed.id } });
  expect(armedAfter!.status).toBe("exhausted");
  // The block epoch is the one now active.
  const blockAfter = await prisma.fairnessChain.findUnique({ where: { id: block.id } });
  expect(blockAfter!.status).toBe("active");
  expect(blockAfter!.saltSource).toBe("eth-block");
  expect(blockAfter!.salt).toBe(BLOCK_HASH);
});

// --- M1c: sanity — strict + real eth-block ACTIVE epoch IS served normally (not retired). ---
test("M1 strict sanity: an eth-block active epoch is served normally (not retired)", async () => {
  process.env[ENV_KEY] = "true";
  process.env[ENV_LEN] = "4";
  fake.ready = false;
  fake.failCommit = false;

  // Clear any leftover servable synth epoch so this block epoch is the sole servable one.
  await prisma.fairnessChain.updateMany({
    where: { status: { in: ["active", "armed", "pending"] }, epoch: { gte: SYNTH_BASE } },
    data: { status: "test_parked" },
  });

  const blockEpoch = (await maxEpoch()) + 1;
  const block = await seedChain({
    epoch: blockEpoch,
    status: "active",
    saltSource: "eth-block",
    salt: BLOCK_HASH, // already resolved + serving
    targetChain: "ethereum",
    targetBlock: 96_000_000,
    length: 4,
  });

  const seed = await fairness.allocateSeed();
  expect(seed).not.toBeNull();
  expect(seed!.chain.salt).toBe(BLOCK_HASH);
  expect(seed!.chain.epoch).toBe(blockEpoch);

  // Untouched — a grind-proof epoch is NOT retired under strict.
  const after = await prisma.fairnessChain.findUnique({ where: { id: block.id } });
  expect(after!.status).toBe("active");
  expect(after!.saltSource).toBe("eth-block");
});
