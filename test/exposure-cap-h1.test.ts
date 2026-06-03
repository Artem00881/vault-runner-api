import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";

/**
 * Regression for audit H1 (round exposure cap is racy / bypassable by parallel
 * bets). `src/game/bets.service.ts`, `docs/audit-2026-06-03.md` H1.
 *
 * PRE-FIX behaviour: every concurrent `placeBet` read the SAME pre-insert
 * `currentExposure` (a plain findMany over status='active'), all passed
 * `checkRoundExposure`, then all inserted + debited — so the aggregate worst-case
 * payout across a round could blow past `RISK_MAX_ROUND_EXPOSURE`. The bankroll
 * circuit-breaker failed under exactly the concurrency it exists for.
 *
 * THE FIX: placeBet now reserves under a per-round Postgres advisory lock
 * (`pg_advisory_xact_lock(hashtext(roundId))`) inside a `$transaction`. Inside the
 * lock it re-reads exposure over bets in status ('active','reserving'), runs
 * `checkRoundExposure`, and inserts a 'reserving' slot; the debit happens OUTSIDE
 * the lock and flips 'reserving'→'active' (or deletes the slot on debit failure).
 * Serializing the read+reserve means concurrent bets can no longer collectively
 * exceed the cap.
 *
 * THE INVARIANT (was violated): sum(potentialPayout) over a round's 'active' bets
 * is <= maxRoundExposure. We size N concurrent bets from N DISTINCT funded users
 * so that only K fit; assert exactly K are accepted, the rest are rejected with
 * `round_exposure_cap`, the surviving exposure is within cap, and NO 'reserving'
 * dust is left behind.
 *
 * env sizing (set on the bun test command): RISK_MAX_MULTIPLIER=1 makes
 * potentialPayout(amount) == amount (1x worst case, neither win-per-bet nor max-bet
 * clamps), so the arithmetic is clean: each bet = 100 → potential payout 100.
 *   RISK_MAX_ROUND_EXPOSURE=350  →  3*100=300 <= 350, 4*100=400 > 350  →  K=3.
 *
 * Distinct users (not same user) means no @@unique([roundId,userId,panel]) race
 * (that is C1) — the ONLY contention here is the shared exposure budget = H1.
 *
 * Uses the internal ledger as the WalletProvider (no operator), real RiskService
 * + MetricsService, and a fake engine pinned to the "betting" phase so the test
 * is deterministic and needs no running game loop.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();

// Fake engine: pins a deterministic round in the betting window. BetsService only
// reads getPublicState() in placeBet, so this is all it needs.
let activeRoundId = "";
const fakeEngine: any = {
  getPublicState: () => ({
    roundId: activeRoundId,
    phase: "betting",
    phaseEndsAt: Date.now() + 5000,
    multiplier: 1.0,
    serverTime: Date.now(),
  }),
  currentMultiplier: () => 1.0,
};

const bets = new BetsService(prisma, ledger, fakeEngine, risk, metrics);

// Test parameters, derived from the env the suite is run with. We DON'T hardcode
// the cap — we read RiskService's resolved limits so the assertions stay true even
// if someone runs with a different RISK_MAX_ROUND_EXPOSURE, and we skip loudly if
// the env wasn't set as the header documents (potentialPayout must equal stake).
const BET_AMOUNT = 100n;
const N_USERS = 10;
const MAX_EXPOSURE = risk.limits.maxRoundExposure;
const PER_BET_EXPOSURE = risk.potentialPayout(BET_AMOUNT);
// How many bets of BET_AMOUNT fit strictly within the cap.
const K_FIT = Number(MAX_EXPOSURE / PER_BET_EXPOSURE);

// This suite is only meaningful when run with the documented env (see header):
// RISK_MAX_MULTIPLIER=1 (→ potentialPayout==stake) and a LOW
// RISK_MAX_ROUND_EXPOSURE that admits some-but-not-all of the N bets. Under the
// DEFAULT env (e.g. a full `bun test` run) the cap is huge and all 10 fit, which
// proves nothing — so we SKIP rather than give a false green or a false red.
// Run the real assertions with:
//   …RISK_MAX_MULTIPLIER=1 RISK_MAX_ROUND_EXPOSURE=350 bun test test/exposure-cap-h1.test.ts
const SIZED = PER_BET_EXPOSURE === BET_AMOUNT && K_FIT >= 1 && K_FIT < N_USERS;

// Track synthetic rows for FK-safe cleanup (rounds cascade bets; users cascade
// wallets/ledger/profiles; seeds then chains last).
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];

async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 2_000_000 + Math.floor(Math.random() * 1_000_000), // synthetic epoch
      commitHash: "h1commit-" + randomUUID(),
      length: 2,
      salt: "h1salt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "h1h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "betting", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function freshUser(balance: bigint): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "h1_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "h1" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

/** Sum of worst-case payout over a round's currently-active bets. */
async function activeExposure(roundId: string): Promise<bigint> {
  const rows = await prisma.bet.findMany({ where: { roundId, status: "active" }, select: { amount: true } });
  return rows.reduce((s, b) => s + risk.potentialPayout(b.amount), 0n);
}

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  try {
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

// Preconditions (only runs when SIZED): confirm the env makes the math clean.
test.skipIf(!SIZED)("H1 preconditions: env sized so potentialPayout==stake and only some bets fit", () => {
  expect(PER_BET_EXPOSURE).toBe(BET_AMOUNT); // RISK_MAX_MULTIPLIER=1 (no win/max-bet clamp)
  expect(K_FIT).toBeGreaterThanOrEqual(1); // at least one bet fits
  expect(K_FIT).toBeLessThan(N_USERS); // but NOT all of them — there must be rejections
  // The cap is an exact multiple of the bet so "fits" is unambiguous (no partial slot).
  expect(MAX_EXPOSURE % PER_BET_EXPOSURE).toBeGreaterThanOrEqual(0n);
});

test.skipIf(!SIZED)("H1: N concurrent bets from distinct users cannot collectively exceed the round exposure cap", async () => {
  activeRoundId = await freshRound();
  const users = await Promise.all(Array.from({ length: N_USERS }, () => freshUser(10_000n)));

  // Fire all N at once on the SAME round / SAME panel. Distinct users → the only
  // shared constraint is the round exposure budget.
  const results = await Promise.all(users.map((u) => bets.placeBet(u.userId, "A", Number(BET_AMOUNT))));

  const accepted = results.filter((r) => r.ok);
  const rejected = results.filter((r) => !r.ok);

  // THE H1 INVARIANT: surviving worst-case exposure is within the cap. Pre-fix this
  // could be N*BET_AMOUNT (all admitted) and blow past it.
  const exposure = await activeExposure(activeRoundId);
  expect(exposure).toBeLessThanOrEqual(MAX_EXPOSURE);

  // Exactly K_FIT admitted; the over-cap attempts are cleanly rejected as
  // round_exposure_cap (not a swallowed bet_failed).
  expect(accepted.length).toBe(K_FIT);
  expect(rejected.length).toBe(N_USERS - K_FIT);
  expect(rejected.every((r) => r.reason === "round_exposure_cap")).toBe(true);

  // The accepted bets account for exactly the surviving exposure.
  expect(exposure).toBe(BigInt(K_FIT) * PER_BET_EXPOSURE);

  // Each accepted bet is a real 'active' row; the count matches.
  const activeRows = await prisma.bet.findMany({ where: { roundId: activeRoundId, status: "active" } });
  expect(activeRows.length).toBe(K_FIT);

  // No 'reserving' dust left behind: every reservation became 'active' or was
  // released (rejected reservations throw inside the tx → rolled back; debit
  // failures delete the slot). A leaked 'reserving' row would silently hold
  // exposure forever and starve a real round.
  const reserving = await prisma.bet.findMany({ where: { roundId: activeRoundId, status: "reserving" } });
  expect(reserving.length).toBe(0);

  // Money sanity: exactly K_FIT debits moved, one per accepted user.
  const acceptedWallets = users
    .filter((_, i) => results[i].ok)
    .map((u) => u.walletId);
  for (const w of acceptedWallets) {
    expect(await ledger.getBalance(w)).toBe(10_000n - BET_AMOUNT);
  }
  // Rejected users were never charged.
  const rejectedWallets = users
    .filter((_, i) => !results[i].ok)
    .map((u) => u.walletId);
  for (const w of rejectedWallets) {
    expect(await ledger.getBalance(w)).toBe(10_000n);
  }
});

test.skipIf(!SIZED)("H1 sanity: the SAME sequence placed single-threaded accepts the same K_FIT", async () => {
  // Proves the advisory lock didn't change the non-concurrent outcome: a serial
  // run admits exactly as many bets as fit, then rejects the rest with the same
  // reason. (Same number accepted as the concurrent case above.)
  activeRoundId = await freshRound();
  const users = await Promise.all(Array.from({ length: N_USERS }, () => freshUser(10_000n)));

  const results: { ok: boolean; reason?: string }[] = [];
  for (const u of users) {
    results.push(await bets.placeBet(u.userId, "A", Number(BET_AMOUNT)));
  }

  const accepted = results.filter((r) => r.ok);
  const rejected = results.filter((r) => !r.ok);
  expect(accepted.length).toBe(K_FIT);
  expect(rejected.length).toBe(N_USERS - K_FIT);
  expect(rejected.every((r) => r.reason === "round_exposure_cap")).toBe(true);

  const exposure = await activeExposure(activeRoundId);
  expect(exposure).toBe(BigInt(K_FIT) * PER_BET_EXPOSURE);
  expect(exposure).toBeLessThanOrEqual(MAX_EXPOSURE);

  const reserving = await prisma.bet.findMany({ where: { roundId: activeRoundId, status: "reserving" } });
  expect(reserving.length).toBe(0);
});
