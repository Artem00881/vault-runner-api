import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService, type Panel } from "../src/game/bets.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { SeamlessOperatorWallet } from "../src/wallet/seamless-operator-wallet";
import { WalletRouter } from "../src/wallet/wallet-router";
import { MockOperator } from "./helpers/mock-operator";

/**
 * Phase 3 — demo / fun mode, end-to-end through BetsService in OPERATOR mode.
 *
 * The WalletProvider is a WalletRouter (real operator wallet + internal ledger). A
 * demo session's bets must flow entirely through the ledger and never reach the
 * operator — including on the OUT-OF-BAND server-driven auto-cashout that carries
 * no socket / client.data and derives everything from persisted rows. A real
 * session in the same suite still routes to the operator (the router isn't just
 * treating everything as demo).
 *
 *   1. demo placeBet → ledger debited, Bet.demo=true, operator NEVER called;
 *   2. demo manual cashOut → ledger credited, payoutTxId set, NOT pending, operator silent;
 *   3. demo auto-cashout (no socket) → pays from the ledger, operator silent;
 *   4. a REAL session's placeBet routes to the operator.
 */

const DEMO_STARTING = 10000n;

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();
const jwt = new JwtService({ secret: "demo-e2e-secret" });
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, ledger);

// Fake engine: one knob flips phase so the same instance drives placeBet ("betting")
// and cashOut / evaluateAutoCashouts ("running").
let activeRoundId = "";
let phase: "betting" | "running" = "betting";
let liveMult = 2.0;
const fakeEngine: any = {
  getPublicState: () => ({
    roundId: activeRoundId,
    phase,
    phaseEndsAt: Date.now() + 60_000,
    multiplier: liveMult,
    serverTime: Date.now(),
  }),
  currentMultiplier: () => liveMult,
};

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];

async function freshRound(status: "betting" | "running"): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 4_200_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "demoe2e-" + randomUUID(),
      length: 2,
      salt: "demoe2e-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "demoe2e-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status, bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function freshOperator(currency = "EUR") {
  const op = await prisma.operator.create({
    data: {
      code: "op-demo-e2e-" + randomUUID().slice(0, 8),
      name: "Demo E2E Operator",
      enabled: true,
      demoEnabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

/** Open a session and return its local userId/walletId for the bet path. */
async function openSession(playerId: string, currency: string, demo: boolean) {
  const op = await freshOperator(currency);
  const token = await launch.issue({ operatorId: op.id, playerId, currency, demo });
  const session = await sessions.openFromToken(token);
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: session.walletId } });
  return { userId: wallet.userId, walletId: session.walletId, playerId, currency };
}

/** Build a BetsService whose WalletProvider is the demo-aware router. */
function betsWithRouter(seed: Record<string, number> = {}) {
  const mockOperator = new MockOperator(seed);
  const seamless = new SeamlessOperatorWallet(mockOperator, sessions.resolver());
  const router = new WalletRouter(ledger, seamless, (w) => sessions.isDemoWallet(w));
  const bets = new BetsService(prisma, router, fakeEngine, risk, metrics);
  return { mockOperator, bets };
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
    for (const operatorId of createdOperatorIds) {
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

test("1. demo placeBet debits the LEDGER, stamps Bet.demo, never calls the operator", async () => {
  activeRoundId = await freshRound("betting");
  phase = "betting";
  const { userId, walletId } = await openSession("e2e-demo-1", "EUR", true);
  const { mockOperator, bets } = betsWithRouter();

  const r = await bets.placeBet(userId, "A" as Panel, 1000, undefined, walletId, undefined, true);
  expect(r.ok).toBe(true);
  expect(r.balance).toBe(9000); // 10000 − 1000, on the ledger

  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: r.betId! } });
  expect(bet.demo).toBe(true);
  expect(bet.status).toBe("active");
  expect(await ledger.getBalance(walletId)).toBe(9000n);
  expect(mockOperator.calls.bet).toBe(0); // play money never hit the operator
});

test("2. demo manual cashOut credits the LEDGER, finalises (not pending), operator silent", async () => {
  activeRoundId = await freshRound("betting");
  phase = "betting";
  const { userId, walletId } = await openSession("e2e-demo-2", "EUR", true);
  const { mockOperator, bets } = betsWithRouter();

  const placed = await bets.placeBet(userId, "A" as Panel, 1000, undefined, walletId, undefined, true);
  expect(placed.ok).toBe(true);

  phase = "running";
  liveMult = 2.0;
  const c = await bets.cashOut(userId, "A" as Panel);
  expect(c.ok).toBe(true);
  expect(c.pending).toBeFalsy(); // the ledger credit never pends
  expect(c.payout).toBe(2000); // 1000 × 2
  expect(await ledger.getBalance(walletId)).toBe(11000n); // 9000 + 2000

  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: placed.betId! } });
  expect(bet.status).toBe("cashed_out");
  expect(bet.payoutTxId).toBeTruthy(); // linked to a real ledger row
  expect(mockOperator.calls.win).toBe(0);
  expect(mockOperator.calls.bet).toBe(0);
});

test("3. demo AUTO-cashout (no socket / client.data) pays from the ledger, operator silent", async () => {
  activeRoundId = await freshRound("betting");
  phase = "betting";
  const { userId, walletId } = await openSession("e2e-demo-3", "EUR", true);
  const { mockOperator, bets } = betsWithRouter();

  // Bet with an auto-cashout target; settlement is server-driven (no client.data),
  // so it must derive demo-ness from the persisted bet/session — the router does.
  const placed = await bets.placeBet(userId, "B" as Panel, 1000, 1.5, walletId, undefined, true);
  expect(placed.ok).toBe(true);

  phase = "running";
  liveMult = 2.0; // past the 1.5 target
  const cashed = await bets.evaluateAutoCashouts(2.0);
  expect(cashed.length).toBe(1);
  expect(cashed[0].payout).toBe(1500); // 1000 × 1.5
  expect(await ledger.getBalance(walletId)).toBe(10500n); // 9000 + 1500
  expect(mockOperator.calls.win).toBe(0);
  expect(mockOperator.calls.bet).toBe(0);
});

test("4. a REAL session's placeBet routes to the OPERATOR (router isn't demo-for-all)", async () => {
  activeRoundId = await freshRound("betting");
  phase = "betting";
  const playerId = "e2e-real-4";
  const currency = "EUR";
  const { userId, walletId } = await openSession(playerId, currency, false);
  const { mockOperator, bets } = betsWithRouter({ [`${playerId}:${currency}`]: 1000 });

  const r = await bets.placeBet(userId, "A" as Panel, 100, undefined, walletId, undefined, false);
  expect(r.ok).toBe(true);
  expect(r.balance).toBe(900); // operator balance after the stake
  expect(mockOperator.calls.bet).toBe(1);

  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: r.betId! } });
  expect(bet.demo).toBe(false);
  const localJournal = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
  expect(localJournal.balance).toBe(0n); // real wallet is never debited locally
});

test("5. money-path HIGH regression: a real cashOut whose mode-lookup THROWS fails CLOSED (payout_pending), never silently ledger-credited; then reconciles to the OPERATOR", async () => {
  activeRoundId = await freshRound("betting");
  phase = "betting";
  const playerId = "e2e-real-5";
  const currency = "EUR";
  const { userId, walletId } = await openSession(playerId, currency, false);

  // One operator, shared by an OK router (lookup works) and a THROWING router
  // (mode-lookup blows up — the transient-failure window from the audit).
  const mockOperator = new MockOperator({ [`${playerId}:${currency}`]: 1000 });
  const seamless = new SeamlessOperatorWallet(mockOperator, sessions.resolver());
  const okBets = new BetsService(
    prisma,
    new WalletRouter(ledger, seamless, (w) => sessions.isDemoWallet(w)),
    fakeEngine,
    risk,
    metrics,
  );
  const throwBets = new BetsService(
    prisma,
    new WalletRouter(ledger, seamless, async () => {
      throw new Error("mode lookup down");
    }),
    fakeEngine,
    risk,
    metrics,
  );

  // Place the real bet while the lookup works → debits the operator.
  const placed = await okBets.placeBet(userId, "A" as Panel, 100, undefined, walletId, undefined, false);
  expect(placed.ok).toBe(true);
  expect(mockOperator.calls.bet).toBe(1);

  // Cash out while the mode-lookup is throwing. The fix: the credit fails CLOSED into
  // payout_pending — it must NOT be silently credited to the play-money ledger and lost.
  phase = "running";
  liveMult = 2.0;
  const c = await throwBets.cashOut(userId, "A" as Panel);
  expect(c.ok).toBe(true);
  expect(c.pending).toBe(true); // deferred, not finalised

  const mid = await prisma.bet.findUniqueOrThrow({ where: { id: placed.betId! } });
  expect(mid.status).toBe("payout_pending");
  expect(mid.payoutTxId).toBeNull(); // NOT finalised against the ledger
  expect(await ledger.getBalance(walletId)).toBe(0n); // and NOT fabricated on the local journal
  expect(mockOperator.calls.win).toBe(0); // operator not paid yet either — just deferred

  // Recovery with a working lookup pays the OPERATOR (source of truth), not the ledger.
  await okBets.reconcilePendingPayouts();
  const done = await prisma.bet.findUniqueOrThrow({ where: { id: placed.betId! } });
  expect(done.status).toBe("cashed_out");
  expect(done.payoutTxId?.startsWith("op-tx-")).toBe(true); // an operator tx id, not a ledger uuid
});
