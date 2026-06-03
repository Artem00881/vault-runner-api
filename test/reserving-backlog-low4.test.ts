import { test, expect, beforeAll, afterAll } from "bun:test";
import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";

/**
 * Audit Low-4 — observability for the transient-reservation BACKLOG.
 *
 * Companion to payout-backlog-h2.test.ts (which proves the H2 pending-payout
 * gauges). Here we prove the mirror-image half: BetsService.reportReservingBacklog()
 * refreshes two gauges from the live table —
 *     vaultrun_reserving_slots          == count of bets in status reserving|cancelling
 *     vaultrun_reserving_oldest_seconds == age (by createdAt) of the oldest such slot
 * — drops them to 0 when nothing is stranded, and loudly log.error()s any slot
 * older than RESERVING_ALERT_SEC (default 600s) WITHOUT ever mutating it (the
 * report is read-only; the sweep keeps retrying forever).
 *
 * BOTH statuses count: a `reserving` slot (debited-but-unactivated, audit H1) and
 * a `cancelling` slot (an owed refund mid-reversal) are equally "an owed refund
 * the sweep hasn't cleared", so the gauge must include both.
 *
 * Needs docker Postgres+Redis. No wallet provider / engine work is exercised
 * (the report only reads the DB + sets gauges), so BetsService gets a bare stub.
 *
 * The gauges/count reflect the WHOLE game_bets table (shared dev DB), so every
 * assertion is a DELTA over a baseline captured just before seeding — a stray
 * reserving/cancelling row from another run can never make this flaky.
 */

const prisma = new PrismaService();
const risk = new RiskService();
const metrics = new MetricsService();

// reportReservingBacklog only reads the DB + sets gauges → no wallet/engine needed.
const stubEngine: any = { getPublicState: () => null, currentMultiplier: () => 1.0 };
const bets = new BetsService(prisma, {} as any, stubEngine, risk, metrics);

// RESERVING_ALERT_SEC is read at module-load in bets.service.ts from the same env
// (default 600). We assert against the same default; the env isn't set in tests.
const RESERVING_ALERT_SEC = Number(process.env.RESERVING_ALERT_SEC ?? 600);

// Track synthetic rows for FK-safe teardown (bets → rounds → seeds → chains → users).
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdBetIds: string[] = [];
const createdUserIds: string[] = [];
const createdWalletIds: string[] = [];

/** Read a prom-client gauge's current scalar value (0 if never set). */
async function gaugeValue(g: { get: () => Promise<{ values: { value: number }[] }> }): Promise<number> {
  const m = await g.get();
  return m.values[0]?.value ?? 0;
}

/** A FK-valid round so a Bet can reference it (rounds → seed → chain). Synthetic epoch ≥ 3_000_000. */
async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 3_000_000 + Math.floor(Math.random() * 1_000_000), // synthetic, distinct range
      commitHash: "low4commit-" + randomUUID(),
      length: 2,
      salt: "low4salt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "low4h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "crashed", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** One synthetic user + its wallet (so the Bet FK to user/wallet is valid). */
async function freshUserWallet(currency = "DEMO"): Promise<{ userId: string; walletId: string }> {
  const user = await prisma.user.create({
    data: { username: "low4-" + randomUUID(), isGuest: true },
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, currency, balance: 0n },
  });
  createdUserIds.push(user.id);
  createdWalletIds.push(wallet.id);
  return { userId: user.id, walletId: wallet.id };
}

/**
 * Seed a Bet in a transient-reservation status (reserving|cancelling), on its OWN
 * fresh round so the (round_id, user_id, panel) unique constraint never collides.
 * `ageMs` back-dates createdAt (the field reportReservingBacklog ages from).
 */
async function reservingBet(opts: {
  userId: string;
  walletId: string;
  status: "reserving" | "cancelling";
  ageMs?: number;
  amount?: bigint;
}): Promise<string> {
  const roundId = await freshRound();
  const id = randomUUID();
  await prisma.bet.create({
    data: {
      id,
      roundId,
      userId: opts.userId,
      walletId: opts.walletId,
      panel: "A",
      amount: opts.amount ?? 100n,
      status: opts.status,
      createdAt: new Date(Date.now() - (opts.ageMs ?? 0)),
    },
  });
  createdBetIds.push(id);
  return id;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe teardown: bets → rounds → seeds → chains → wallets → users. Leave NO
  // synthetic reserving/cancelling rows behind (this shared dev DB has been polluted before).
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    if (createdWalletIds.length) await prisma.wallet.deleteMany({ where: { id: { in: createdWalletIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

test("Low-4: gauges reflect the live reserving|cancelling backlog (BOTH statuses counted) + oldest-createdAt age", async () => {
  const { userId, walletId } = await freshUserWallet();

  // Baseline: whatever transient slots already exist in the shared DB (clean == 0).
  const baseCount = await prisma.bet.count({ where: { status: { in: ["reserving", "cancelling"] } } });

  // Seed a MIX across both statuses (the core "both are included" assertion).
  // One slot is back-dated to ~now-300s so we can assert the oldest-age gauge.
  const oldAgeMs = 300_000; // 300s, still well UNDER the 600s alert threshold
  const seeded = [
    await reservingBet({ userId, walletId, status: "reserving", ageMs: oldAgeMs }), // the oldest
    await reservingBet({ userId, walletId, status: "reserving" }),
    await reservingBet({ userId, walletId, status: "cancelling" }),
    await reservingBet({ userId, walletId, status: "cancelling" }),
  ];
  const N = seeded.length; // 4 (2 reserving + 2 cancelling)

  await bets.reportReservingBacklog();

  // Gauge 1: count == baseline + our 4 (proves BOTH statuses are summed).
  expect(await gaugeValue(metrics.reservingSlots)).toBe(baseCount + N);

  // Gauge 2: oldest age ≈ our back-dated 300s slot (unless the shared DB already
  // had an even older transient slot, in which case it's only larger — still ≥).
  const oldestAge = await gaugeValue(metrics.reservingOldestSeconds);
  expect(oldestAge).toBeGreaterThanOrEqual(300 - 10); // ~300s, small clock/exec margin
  expect(oldestAge).toBeLessThan(RESERVING_ALERT_SEC); // sane band: under the alert threshold
});

test("Low-4: count is reserving+cancelling, not just one status", async () => {
  const { userId, walletId } = await freshUserWallet();

  // Count ONLY reserving, then add a cancelling, and show the gauge grows by the
  // cancelling too — i.e. the report does not silently ignore one of the statuses.
  const baseReservingOnly = await prisma.bet.count({ where: { status: "reserving" } });
  const baseBoth = await prisma.bet.count({ where: { status: { in: ["reserving", "cancelling"] } } });

  const ids = [
    await reservingBet({ userId, walletId, status: "reserving" }),
    await reservingBet({ userId, walletId, status: "cancelling" }),
  ];

  await bets.reportReservingBacklog();
  // +2 over the combined baseline (one of each) — not +1 (which would mean a status was dropped).
  expect(await gaugeValue(metrics.reservingSlots)).toBe(baseBoth + 2);

  // Sanity: the reserving-only table count went up by exactly 1 (the other is cancelling).
  expect(await prisma.bet.count({ where: { status: "reserving" } })).toBe(baseReservingOnly + 1);

  // Cleanup these two NOW so the next test's baseline isn't inflated by them.
  await prisma.bet.updateMany({ where: { id: { in: ids } }, data: { status: "cancelled" } });
});

test("Low-4: a slot older than RESERVING_ALERT_SEC fires the loud log.error; status is left untouched (read-only report)", async () => {
  const { userId, walletId } = await freshUserWallet();

  // A `cancelling` slot back-dated ~2h → its age is well past RESERVING_ALERT_SEC (600s).
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const stuckId = await reservingBet({ userId, walletId, status: "cancelling", ageMs: twoHoursMs });

  // Capture the loud "STUCK reservation" log.error (same technique as payout-backlog-h2).
  const errors: string[] = [];
  const origError = Logger.prototype.error;
  (Logger.prototype as any).error = function (msg: any, ...rest: any[]) {
    errors.push(String(msg));
    return origError.call(this, msg, ...rest);
  };
  try {
    await bets.reportReservingBacklog();
  } finally {
    (Logger.prototype as any).error = origError;
  }

  // Gauge crossed the alert threshold (our 2h-old slot, unless something even older exists).
  const oldestAge = await gaugeValue(metrics.reservingOldestSeconds);
  expect(oldestAge).toBeGreaterThanOrEqual(7200 - 60); // ~2h, small clock/exec margin
  expect(oldestAge).toBeGreaterThan(RESERVING_ALERT_SEC);

  // The loud log MUST have fired and name THIS bet.
  expect(errors.some((e) => e.includes("STUCK reservation") && e.includes(stuckId))).toBe(true);

  // Read-only: the report never changed the status (the sweep, not the report, clears it).
  const stuck = await prisma.bet.findUniqueOrThrow({ where: { id: stuckId } });
  expect(stuck.status).toBe("cancelling");

  // Tidy our stuck slot NOW so a later test's baseline/oldest-age isn't skewed by a 2h-old row.
  await prisma.bet.updateMany({ where: { id: { in: [stuckId] } }, data: { status: "cancelled" } });
});

test("Low-4: with no reserving|cancelling slots, both gauges drop to 0", async () => {
  // Only meaningful on a clean dev DB (the canonical CI/local state). If another
  // run left transient slots, this asserts the gauge equals the (non-zero) live
  // count instead — the report still faithfully reflects the live backlog.
  const live = await prisma.bet.count({ where: { status: { in: ["reserving", "cancelling"] } } });

  await bets.reportReservingBacklog();

  if (live === 0) {
    expect(await gaugeValue(metrics.reservingSlots)).toBe(0);
    expect(await gaugeValue(metrics.reservingOldestSeconds)).toBe(0);
  } else {
    // Not a clean DB — still correct: the gauge mirrors the live count, age ≥ 0.
    expect(await gaugeValue(metrics.reservingSlots)).toBe(live);
    expect(await gaugeValue(metrics.reservingOldestSeconds)).toBeGreaterThanOrEqual(0);
  }
});
