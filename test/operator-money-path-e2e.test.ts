import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { WalletRouter } from "../src/wallet/wallet-router";
import { SeamlessOperatorWallet } from "../src/wallet/seamless-operator-wallet";
import { MockOperator } from "./helpers/mock-operator";

/**
 * Item 2 — the missing real-money money-path e2e (DB-backed, OPERATOR seamless wallet).
 *
 * The other operator suites cover the WALLET TRANSPORT in isolation
 * (operator-wallet-e2e over a real socket) or the session/resolver wiring
 * (operator-session-c2). NONE drives a full placeBet → cashOut through the GAME
 * (BetsService) against a real OPERATOR wallet with a real DB bet row. This does.
 *
 * Wiring mirrors operator mode: BetsService talks to a WalletRouter(ledger,
 * SeamlessOperatorWallet, isDemoWallet) so money for a REAL (non-demo) operator
 * session routes to the operator, while demo would route to the ledger. The
 * operator wallet is an IN-PROCESS MockOperator (idempotent in-memory balance) —
 * the task's preferred approach (the HTTP transport is already covered by
 * operator-wallet-e2e), so the test is fast + flake-free.
 *
 * Proves:
 *  (a) HAPPY PATH — placeBet debits the OPERATOR balance by the stake; cashOut
 *      credits the payout; the Bet row ends `cashed_out` with a payoutTxId (the
 *      operator's non-uuid tx id).
 *  (b) OVER-GLOBAL CLAMP — a bet whose per-currency maxWinPerBet is ABOVE a small
 *      global RISK_MAX_WIN_PER_BET pays exactly the GLOBAL cap on cashOut, end to
 *      end through the operator credit (capPayout intersects to the global cap, so
 *      a higher per-currency cap can never over-pay / under-reserve the bankroll).
 */

// Small GLOBAL win cap so the over-global clamp is observable. RiskService reads these
// at construction → set BEFORE `new RiskService()`. We restore them in afterAll.
const SAVED_ENV: Record<string, string | undefined> = {
  RISK_MAX_WIN_PER_BET: process.env.RISK_MAX_WIN_PER_BET,
  RISK_MAX_MULTIPLIER: process.env.RISK_MAX_MULTIPLIER,
  RISK_MAX_ROUND_EXPOSURE: process.env.RISK_MAX_ROUND_EXPOSURE,
  RISK_MAX_BET: process.env.RISK_MAX_BET,
};
process.env.RISK_MAX_WIN_PER_BET = "10000"; // GLOBAL single-bet win cap (minor units)
process.env.RISK_MAX_MULTIPLIER = "1000";
process.env.RISK_MAX_ROUND_EXPOSURE = "100000000";
process.env.RISK_MAX_BET = "1000000";

const JWT_SECRET = "mpe2e-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma));

// The in-process OPERATOR wallet (source of truth for real money). Balances are
// keyed `${playerId}:${currency}`; seeded per-launch below.
const operatorApi = new MockOperator();
// The game-facing provider for REAL sessions: SeamlessOperatorWallet → MockOperator,
// resolving walletId → operator session via the production resolver.
const seamless = new SeamlessOperatorWallet(operatorApi, sessions.resolver());
// Operator-mode money router: demo → ledger, real → operator (by persisted wallet mode).
const router = new WalletRouter(ledger, seamless, (walletId) => sessions.isDemoWallet(walletId));

// Authoritative engine stand-in (server clock decides phase). Knobs set per test.
let activeRoundId = "";
let phase: "betting" | "running" = "betting";
let liveMult = 2.0;
const fakeEngine: any = {
  getPublicState: () => ({ roundId: activeRoundId, phase, phaseEndsAt: Date.now() + 60_000, multiplier: liveMult, serverTime: Date.now() }),
  currentMultiplier: () => liveMult,
};
const bets = new BetsService(prisma, router, fakeEngine, risk, metrics);

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];

async function makeRound(status: string): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: { epoch: 5_500_000 + Math.floor(Math.random() * 1_000_000), commitHash: "mp-" + randomUUID(), length: 2, salt: "mp-" + randomUUID(), status: "exhausted" },
  });
  const seed = await prisma.fairnessSeed.create({ data: { chainId: chain.id, chainIndex: 1, seedHash: "mp-" + randomUUID() } });
  const round = await prisma.round.create({ data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status, bettingOpensAt: new Date() } });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/**
 * Launch a REAL (non-demo) operator session so the journal wallet + GameSession +
 * resolver all exist, and seed the OPERATOR-side balance for this player+currency.
 * `betLimits` (optional) rides the play token → the per-currency maxWinPerBet is
 * stamped on the bet at placeBet (drives the clamp test).
 */
async function launchReal(opts: { currency?: string; operatorBalance: number; betLimits?: unknown }) {
  const currency = opts.currency ?? "EUR";
  const op = await prisma.operator.create({
    data: {
      code: "op-mp-" + randomUUID().slice(0, 8),
      name: "Money-Path Operator",
      enabled: true,
      demoEnabled: false,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
      ...(opts.betLimits !== undefined ? { betLimits: opts.betLimits as object } : {}),
    },
  });
  createdOperatorIds.push(op.id);
  const playerId = "p-" + randomUUID().slice(0, 8);
  const token = await launch.issue({ operatorId: op.id, playerId, currency });
  const s = await sessions.openFromToken(token); // NON-demo → router settles on the operator
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: s.walletId } });
  // Seed the OPERATOR-side balance for this player+currency (the source of truth).
  operatorApi.seed(playerId, currency, opts.operatorBalance);
  return { op, playerId, currency, walletId: s.walletId, userId: wallet.userId };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // Restore RISK_* env (the bun process is shared across test files).
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    for (const operatorId of createdOperatorIds) {
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

describe("operator money-path e2e (DB-backed, seamless operator wallet)", () => {
  test("(a) happy path: placeBet debits the operator, cashOut credits the operator, bet cashed_out + payoutTxId", async () => {
    const startBalance = 100_000;
    const { walletId, userId, playerId, currency } = await launchReal({ operatorBalance: startBalance });

    // Sanity: the router classifies this REAL wallet as NON-demo → operator-routed.
    expect(await sessions.isDemoWallet(walletId)).toBe(false);
    // And getBalance reads the OPERATOR's balance, not the (0) local journal wallet.
    expect(await router.getBalance(walletId)).toBe(BigInt(startBalance));

    // PLACE — debits the OPERATOR by the stake (1000).
    phase = "betting";
    activeRoundId = await makeRound("betting");
    const stake = 1000;
    const placed = await bets.placeBet(userId, "A", stake, undefined, walletId);
    expect(placed.ok).toBe(true);
    expect(operatorApi.balanceOf(playerId, currency)).toBe(startBalance - stake); // 99_000
    expect(operatorApi.calls.bet).toBeGreaterThanOrEqual(1);

    // The bet row is active and DEBITED (debitTxId = the operator's non-uuid tx id).
    const afterPlace = await prisma.bet.findUniqueOrThrow({ where: { id: placed.betId! } });
    expect(afterPlace.status).toBe("active");
    expect(afterPlace.debitTxId).toBeTruthy();
    expect(afterPlace.debitTxId!.startsWith("op-tx-")).toBe(true); // operator-side id, not a uuid

    // CASH OUT at 2.0x → payout 2000, well under the global cap → credits the operator.
    phase = "running";
    liveMult = 2.0;
    // The authoritative crash gate (bets.service Finding 1) reads the bet's OWN DB Round
    // row: it must be `running` with crashPoint (5.0) strictly above the cash-out mult
    // (2.0) for a legitimate running cash-out. Mirror the engine's running phase in the DB.
    await prisma.round.update({ where: { id: activeRoundId }, data: { status: "running" } });
    const cashed = await bets.cashOut(userId, "A");
    expect(cashed.ok).toBe(true);
    expect(cashed.pending).toBeFalsy(); // operator confirmed the credit (no payout_pending)
    expect(cashed.payout).toBe(stake * 2); // 2000

    // OPERATOR balance reflects debit then credit: 100_000 - 1000 + 2000 = 101_000.
    expect(operatorApi.balanceOf(playerId, currency)).toBe(startBalance - stake + stake * 2);
    expect(operatorApi.calls.win).toBeGreaterThanOrEqual(1);

    // The bet row is finalised: cashed_out with the operator's payout tx id linked.
    const afterCash = await prisma.bet.findUniqueOrThrow({ where: { id: placed.betId! } });
    expect(afterCash.status).toBe("cashed_out");
    expect(afterCash.payout).toBe(2000n);
    expect(afterCash.payoutTxId).toBeTruthy();
    expect(afterCash.payoutTxId!.startsWith("op-tx-")).toBe(true);
  });

  test("(b) over-global clamp: a per-currency maxWinPerBet ABOVE the global cap still pays only the GLOBAL cap on the operator credit", async () => {
    // Global RISK_MAX_WIN_PER_BET = 10_000 (suite env). The operator configures a
    // GENEROUS per-currency win cap (1_000_000) ABOVE the global. capPayout must
    // INTERSECT down to the global cap, so the operator is credited only 10_000 — the
    // round-exposure breaker reserves against the GLOBAL cap, so a higher per-currency
    // cap would under-reserve the bankroll (money-path HIGH). Proven end to end here.
    const startBalance = 1_000_000;
    const { walletId, userId, playerId, currency } = await launchReal({
      operatorBalance: startBalance,
      // maxWinPerBet 1_000_000 >> global 10_000; maxBet generous enough for the stake.
      betLimits: { EUR: { minBet: 1, maxBet: 100000, maxWinPerBet: 1000000 } },
    });

    // PLACE a 5000 stake; the per-currency maxWinPerBet (1_000_000) is stamped on the bet.
    phase = "betting";
    activeRoundId = await makeRound("betting");
    const stake = 5000;
    const placed = await bets.placeBet(
      userId,
      "A",
      stake,
      undefined,
      walletId,
      { minBet: 1n, maxBet: 100000n, maxWinPerBet: 1000000n }, // the resolved per-currency limits
    );
    expect(placed.ok).toBe(true);
    expect(operatorApi.balanceOf(playerId, currency)).toBe(startBalance - stake);

    // The bet stamped THIS bet's per-currency win cap (1_000_000) — above the global.
    const afterPlace = await prisma.bet.findUniqueOrThrow({ where: { id: placed.betId! } });
    expect(afterPlace.maxWinPerBet).toBe(1_000_000n);

    // CASH OUT at 100x → raw payout 5000*100 = 500_000, which exceeds BOTH the
    // per-currency cap (1_000_000 — not hit) and, crucially, the GLOBAL cap (10_000).
    // capPayout intersects to the global → pays exactly 10_000.
    phase = "running";
    liveMult = 100.0;
    // Authoritative crash gate: the DB Round must be `running` AND its crashPoint strictly
    // above the cash-out mult (100x) for this to be a legitimate in-flight cash-out — the
    // round factory's default 5.0 would (correctly) read as already-crashed at 100x. Raise
    // crashPoint above 100 so the clamp (not the crash gate) is what's under test here.
    await prisma.round.update({ where: { id: activeRoundId }, data: { status: "running", crashPoint: 200.0 } });
    const cashed = await bets.cashOut(userId, "A");
    expect(cashed.ok).toBe(true);
    expect(cashed.payout).toBe(10_000); // GLOBAL cap, NOT 500_000 and NOT 1_000_000

    // The OPERATOR was credited exactly the global cap: 1_000_000 - 5000 + 10_000.
    expect(operatorApi.balanceOf(playerId, currency)).toBe(startBalance - stake + 10_000);
    const afterCash = await prisma.bet.findUniqueOrThrow({ where: { id: placed.betId! } });
    expect(afterCash.status).toBe("cashed_out");
    expect(afterCash.payout).toBe(10_000n); // clamped value persisted on the row
  });
});
