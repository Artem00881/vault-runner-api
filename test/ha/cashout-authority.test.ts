import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../src/prisma/prisma.service";
import { LedgerService } from "../../src/wallet/ledger.service";
import { RiskService } from "../../src/game/risk.service";
import { MetricsService } from "../../src/metrics/metrics.service";
import { BetsService, type Panel } from "../../src/game/bets.service";
import { LaunchTokenService } from "../../src/operator/launch-token.service";
import { GameSessionService } from "../../src/operator/game-session.service";
import { SeamlessOperatorWallet } from "../../src/wallet/seamless-operator-wallet";
import { WalletRouter } from "../../src/wallet/wallet-router";
import { MockOperator } from "../helpers/mock-operator";
import { makeAudit } from "../helpers/audit";

/**
 * Phase 4.5c.1 — REGRESSION for the AUTHORITATIVE crash gate in BetsService.cashOut
 * (money-path-auditor Finding 1). DB-backed, direct-instantiation style.
 *
 * The fix re-validates a manual/auto cash-out against the bet's OWN Round row (the DB is
 * authoritative) AFTER the engine phase gate: the round must still be `running` AND the
 * live multiplier must be STRICTLY below the (server-only) crashPoint. The engine's
 * getPublicState() is, on a FOLLOWER node, a CACHED view that can lag the leader's crash
 * publish — without the gate a follower could pay a cash-out ABOVE the real crash, MINTING
 * money. The DB round can never be stale (the leader writes `crashed` atomically with the
 * crash), so reading it makes cash-out node-independent.
 *
 * Wiring mirrors operator mode: BetsService → WalletRouter(ledger, SeamlessOperatorWallet,
 * isDemoWallet). A REAL (non-demo) session routes the money to the in-process MockOperator,
 * so each negative case can assert BOTH ledger AND operator money is untouched.
 *
 *  POSITIVE control — DB `running`, crashPoint 5.0, mult 2.0 → cashOut succeeds, pays
 *    stake×2, bet ends `cashed_out`, operator credited once.
 *  NEGATIVE 1 (the FIX — follower-stale) — engine reports `running` + a multiplier but the
 *    DB Round is `crashed` (leader already recorded the crash) → `{ok:false, "too_late"}`,
 *    bet stays `active` (NOT cashed_out), no payout ledger row, no operator credit. This is
 *    the case that FAILS WITHOUT the fix (it would pay above the crash).
 *  NEGATIVE 2 (the FIX — busted: cashed out too late) — DB `running` but mult >= crashPoint
 *    (crashPoint 2.0, mult 2.5) → `too_late`, bet stays active, no payout, no operator credit.
 */

// Generous global risk caps so the gate — not a clamp — is what's under test.
const SAVED_ENV: Record<string, string | undefined> = {
  RISK_MAX_WIN_PER_BET: process.env.RISK_MAX_WIN_PER_BET,
  RISK_MAX_MULTIPLIER: process.env.RISK_MAX_MULTIPLIER,
  RISK_MAX_ROUND_EXPOSURE: process.env.RISK_MAX_ROUND_EXPOSURE,
  RISK_MAX_BET: process.env.RISK_MAX_BET,
};
process.env.RISK_MAX_WIN_PER_BET = "100000000";
process.env.RISK_MAX_MULTIPLIER = "1000";
process.env.RISK_MAX_ROUND_EXPOSURE = "100000000";
process.env.RISK_MAX_BET = "10000000";

const JWT_SECRET = "cashout-authority-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));

// One operator wallet (source of truth for real money) shared across the cases.
const operatorApi = new MockOperator();
const seamless = new SeamlessOperatorWallet(operatorApi, sessions.resolver());
const router = new WalletRouter(ledger, seamless, (walletId) => sessions.isDemoWallet(walletId));

// Authoritative-engine stand-in. The DB round status is what the FIX trusts; this mock is
// the (possibly-stale) follower view — we deliberately keep it `running` for every case.
let activeRoundId = "";
let phase: "betting" | "running" = "betting";
let liveMult = 2.0;
const fakeEngine: any = {
  getPublicState: () => ({ roundId: activeRoundId, phase, phaseEndsAt: Date.now() + 60_000, multiplier: liveMult, serverTime: Date.now() }),
  currentMultiplier: () => liveMult,
};
const bets = new BetsService(prisma, router, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];

/** Create a Round at a given DB status + crashPoint (the authoritative values the gate reads). */
async function makeRound(status: string, crashPoint: number): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: { epoch: 6_500_000 + Math.floor(Math.random() * 1_000_000), commitHash: "ca-" + randomUUID(), length: 2, salt: "ca-" + randomUUID(), status: "exhausted" },
  });
  const seed = await prisma.fairnessSeed.create({ data: { chainId: chain.id, chainIndex: 1, seedHash: "ca-" + randomUUID() } });
  const round = await prisma.round.create({ data: { seedId: seed.id, nonce: 1n, crashPoint, status, bettingOpensAt: new Date() } });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** Launch a REAL (non-demo) operator session + seed the operator-side balance. */
async function launchReal(operatorBalance: number) {
  const currency = "EUR";
  const op = await prisma.operator.create({
    data: {
      code: "op-ca-" + randomUUID().slice(0, 8),
      name: "Cashout-Authority Operator",
      enabled: true,
      demoEnabled: false,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
    },
  });
  createdOperatorIds.push(op.id);
  const playerId = "p-" + randomUUID().slice(0, 8);
  const token = await launch.issue({ operatorId: op.id, playerId, currency });
  const s = await sessions.openFromToken(token); // NON-demo → operator-routed money
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: s.walletId } });
  operatorApi.seed(playerId, currency, operatorBalance);
  return { op, playerId, currency, walletId: s.walletId, userId: wallet.userId };
}

/** Place an ACTIVE bet on `activeRoundId` (which must be a `betting` DB round at call time). */
async function placeActiveBet(userId: string, walletId: string, panel: Panel, stake: number) {
  phase = "betting";
  const placed = await bets.placeBet(userId, panel, stake, undefined, walletId, undefined, false);
  expect(placed.ok).toBe(true);
  const row = await prisma.bet.findUniqueOrThrow({ where: { id: placed.betId! } });
  expect(row.status).toBe("active");
  return placed.betId!;
}

/** Count a wallet's payout_credit ledger rows — proves no payout was credited locally. */
async function payoutCreditRows(walletId: string): Promise<number> {
  return prisma.ledgerTransaction.count({ where: { walletId, type: "payout_credit" } });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
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

describe("cashOut authoritative crash gate (Finding 1) — DB round is the source of truth", () => {
  test("POSITIVE: DB round running + mult below crashPoint → pays stake×2, bet cashed_out, operator credited once", async () => {
    const startBalance = 100_000;
    const { walletId, userId, playerId, currency } = await launchReal(startBalance);
    const stake = 1000;

    // ACTIVE bet on a betting round.
    activeRoundId = await makeRound("betting", 5.0);
    const betId = await placeActiveBet(userId, walletId, "A", stake);
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance - stake));
    const winsBefore = operatorApi.calls.win;

    // Engine running + DB round AUTHORITATIVELY running, crashPoint 5.0 > mult 2.0 → legit.
    phase = "running";
    liveMult = 2.0;
    await prisma.round.update({ where: { id: activeRoundId }, data: { status: "running" } });

    const cashed = await bets.cashOut(userId, "A");
    expect(cashed.ok).toBe(true);
    expect(cashed.pending).toBeFalsy();
    expect(cashed.payout).toBe(stake * 2); // 2000

    const after = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(after.status).toBe("cashed_out");
    expect(after.payout).toBe(2000n);
    expect(after.payoutTxId).toBeTruthy();

    // Operator was credited exactly once: 100_000 − 1000 + 2000.
    expect(operatorApi.balanceOf(playerId, currency)).toBe(BigInt(startBalance - stake + stake * 2));
    expect(operatorApi.calls.win).toBe(winsBefore + 1);
  });

  test("THE FIX (negative 1): follower-stale — engine says running, DB round CRASHED → too_late, bet stays active, NO money moves", async () => {
    // WITHOUT the gate this OVER-PAYS above the crash (the multi-node money leak): the
    // engine view is `running` + mult 3.0, but the leader already recorded the crash in
    // the DB. The gate reads the DB round (`crashed`) and refuses.
    const startBalance = 100_000;
    const { walletId, userId, playerId, currency } = await launchReal(startBalance);
    const stake = 1000;

    activeRoundId = await makeRound("betting", 5.0);
    const betId = await placeActiveBet(userId, walletId, "A", stake);
    const balAfterStake = operatorApi.balanceOf(playerId, currency); // 99_000n
    expect(balAfterStake).toBe(BigInt(startBalance - stake));
    const winsBefore = operatorApi.calls.win;
    const creditRowsBefore = await payoutCreditRows(walletId);

    // Follower view = running + a live multiplier; the AUTHORITATIVE DB round = crashed.
    phase = "running";
    liveMult = 3.0; // a multiplier the stale follower would happily pay
    await prisma.round.update({ where: { id: activeRoundId }, data: { status: "crashed", crashedAt: new Date() } });

    const c = await bets.cashOut(userId, "A");
    expect(c.ok).toBe(false);
    expect(c.reason).toBe("too_late");

    // The bet is UNTOUCHED — still active, never claimed, no payout recorded.
    const after = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(after.status).toBe("active");
    expect(after.payout).toBe(0n);
    expect(after.payoutTxId).toBeNull();
    expect(after.cashoutMult).toBeNull();

    // And NO money moved: operator never credited, no payout_credit ledger row.
    expect(operatorApi.balanceOf(playerId, currency)).toBe(balAfterStake);
    expect(operatorApi.calls.win).toBe(winsBefore);
    expect(await payoutCreditRows(walletId)).toBe(creditRowsBefore);
  });

  test("THE FIX (negative 2): busted — DB running but mult >= crashPoint → too_late, bet stays active, NO money moves", async () => {
    // The round is authoritatively running, but the player tried to cash out at/above the
    // crash (crashPoint 2.0, mult 2.5) — the bet busted. The gate's `mult >= crashPoint`
    // arm refuses, so a too-late cash-out can't be paid even on the leader.
    const startBalance = 100_000;
    const { walletId, userId, playerId, currency } = await launchReal(startBalance);
    const stake = 1000;

    activeRoundId = await makeRound("betting", 2.0); // low crashPoint
    const betId = await placeActiveBet(userId, walletId, "A", stake);
    const balAfterStake = operatorApi.balanceOf(playerId, currency);
    const winsBefore = operatorApi.calls.win;
    const creditRowsBefore = await payoutCreditRows(walletId);

    // DB authoritatively running, but the cash-out multiplier is AT/ABOVE the crash.
    phase = "running";
    liveMult = 2.5; // >= crashPoint 2.0 → busted
    await prisma.round.update({ where: { id: activeRoundId }, data: { status: "running" } });

    const c = await bets.cashOut(userId, "A");
    expect(c.ok).toBe(false);
    expect(c.reason).toBe("too_late");

    const after = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(after.status).toBe("active"); // untouched (settleRound would later bust it)
    expect(after.payout).toBe(0n);
    expect(after.payoutTxId).toBeNull();

    expect(operatorApi.balanceOf(playerId, currency)).toBe(balAfterStake);
    expect(operatorApi.calls.win).toBe(winsBefore);
    expect(await payoutCreditRows(walletId)).toBe(creditRowsBefore);
  });
});
