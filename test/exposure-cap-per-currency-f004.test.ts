import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { makeAudit } from "./helpers/audit";

/**
 * Regression for F-004: the per-round exposure cap must be tracked + enforced PER CURRENCY.
 *
 * THE DEFECT (now fixed): a round is shared across currencies, but checkRoundExposure summed
 * `potentialPayout(amount)` over ALL active/reserving bets as undifferentiated minor units —
 * 100 minor units of EUR + 100 of USD counted as "200" against one global cap, with no FX.
 * That weakened the bankroll circuit-breaker for a multi-currency round (it could reject a
 * legitimate bet in one currency because a DIFFERENT currency had filled the shared cap, and
 * conversely under-bound real house liability).
 *
 * THE FIX under test (bets.service.ts): only the bets in the NEW bet's currency count toward
 * the cap it is checked against — each currency accumulates + caps independently against the
 * same RISK_MAX_ROUND_EXPOSURE ceiling.
 *
 * Self-contained: builds a RiskService with RISK_MAX_MULTIPLIER=1 (so potentialPayout==stake)
 * and a LOW RISK_MAX_ROUND_EXPOSURE, regardless of the run env, and drives real placeBet over
 * the internal ledger + a fake engine pinned to the betting window (mirrors exposure-cap-h1).
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const metrics = new MetricsService();

// EXPOSURE_CAP minor units; with RISK_MAX_MULTIPLIER=1, potentialPayout(stake)==stake, so the
// cap admits exactly EXPOSURE_CAP worth of stake PER CURRENCY.
const EXPOSURE_CAP = 200n;

// Build a RiskService with a fixed low cap (save/restore process.env so other suites are
// unaffected — RiskService reads env in its field initializers at construction time).
function makeRisk(): RiskService {
  const env: Record<string, string> = {
    RISK_MIN_BET: "1",
    RISK_MAX_BET: "1000000",
    RISK_MAX_WIN_PER_BET: "1000000000", // huge → never the binding cap here
    RISK_MAX_MULTIPLIER: "1", // potentialPayout == stake (clean arithmetic)
    RISK_MAX_ROUND_EXPOSURE: EXPOSURE_CAP.toString(),
  };
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const r = new RiskService();
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  return r;
}
const risk = makeRisk();

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

const bets = new BetsService(prisma, ledger, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];

async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 6_000_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "f004c-" + randomUUID(),
      length: 2,
      salt: "f004s-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "f004h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "betting", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** A funded user whose single wallet is in `currency` (distinct users → no panel-unique race). */
async function freshUser(currency: string, balance: bigint): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "f004_" + id.slice(0, 12),
      wallets: { create: { currency, balance } },
      profile: { create: { displayName: "f004" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  try {
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    for (const userId of createdUserIds) {
      await prisma.bet.deleteMany({ where: { userId } });
      await prisma.ledgerTransaction.deleteMany({ where: { wallet: { userId } } });
      await prisma.profile.deleteMany({ where: { userId } });
      await prisma.wallet.deleteMany({ where: { userId } });
    }
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

test("F-004: round exposure caps each currency INDEPENDENTLY (a full EUR cap does not block a USD bet)", async () => {
  activeRoundId = await freshRound();

  // Fill the EUR currency's exposure to exactly the cap (200) with two 100-unit EUR bets from
  // distinct users (potentialPayout==stake under maxMultiplier=1).
  const eur1 = await freshUser("EUR", 10_000n);
  const eur2 = await freshUser("EUR", 10_000n);
  expect((await bets.placeBet(eur1.userId, "A", 100)).ok).toBe(true);
  expect((await bets.placeBet(eur2.userId, "A", 100)).ok).toBe(true);

  // A THIRD EUR bet now exceeds the EUR cap (200 + 100 > 200) → rejected.
  const eur3 = await freshUser("EUR", 10_000n);
  const eurOver = await bets.placeBet(eur3.userId, "A", 100);
  expect(eurOver.ok).toBe(false);
  expect(eurOver.reason).toBe("round_exposure_cap");

  // THE F-004 PROOF: a USD bet on the SAME round is ACCEPTED — its currency's accumulator is
  // empty (0), independent of EUR. Under the OLD cross-currency sum this would have been
  // rejected because EUR already filled the single global cap.
  const usd1 = await freshUser("USD", 10_000n);
  const usdOk = await bets.placeBet(usd1.userId, "A", 100);
  expect(usdOk.ok).toBe(true);

  // And USD is itself capped independently: fill it to the cap, then the next USD bet rejects.
  const usd2 = await freshUser("USD", 10_000n);
  expect((await bets.placeBet(usd2.userId, "A", 100)).ok).toBe(true); // USD now at 200
  const usd3 = await freshUser("USD", 10_000n);
  const usdOver = await bets.placeBet(usd3.userId, "A", 100);
  expect(usdOver.ok).toBe(false);
  expect(usdOver.reason).toBe("round_exposure_cap");

  // Ledger-level sanity: 2 EUR + 2 USD bets actually debited (the rejected ones did not).
  const active = await prisma.bet.findMany({ where: { roundId: activeRoundId, status: "active" }, select: { currency: true } });
  expect(active.filter((b) => b.currency === "EUR").length).toBe(2);
  expect(active.filter((b) => b.currency === "USD").length).toBe(2);
});
