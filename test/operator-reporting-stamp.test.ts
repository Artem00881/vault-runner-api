import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService, type Panel } from "../src/game/bets.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { makeAudit } from "./helpers/audit";

/**
 * Phase 3.5 — Bet STAMP regression (DB-backed). placeBet denormalises onto the Bet
 * row the two fields the operator reporting aggregation scopes by:
 *   - operatorId: from the VERIFIED play token (betCtx.operatorId); NULL for a guest;
 *   - currency:   the wallet's canonical UPPERCASE code.
 * This proves the reporting pipeline gets correctly-tagged rows and that the guest /
 * internal play path is unchanged (operatorId NULL → excluded from operator reports).
 *
 * Uses the real BetsService with the internal ledger as the WalletProvider (mirrors
 * the RG-enforcement harness), and a fake engine whose phase knob = "betting".
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();
const jwt = new JwtService({ secret: "stamp-secret" });
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, ledger, makeAudit(prisma));

let activeRoundId = "";
const fakeEngine: any = {
  getPublicState: () => ({ roundId: activeRoundId, phase: "betting", phaseEndsAt: Date.now() + 60_000, multiplier: 1, serverTime: Date.now() }),
  currentMultiplier: () => 1,
};
const bets = new BetsService(prisma, ledger, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];
const createdUserIds: string[] = [];

async function makeRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: { epoch: 4_500_000 + Math.floor(Math.random() * 1_000_000), commitHash: "stamp-" + randomUUID(), length: 2, salt: "stamp-" + randomUUID(), status: "exhausted" },
  });
  const seed = await prisma.fairnessSeed.create({ data: { chainId: chain.id, chainIndex: 1, seedHash: "stamp-" + randomUUID() } });
  const round = await prisma.round.create({ data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status: "betting", bettingOpensAt: new Date() } });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function freshOperator(currency: string) {
  const op = await prisma.operator.create({
    data: {
      code: "op-stamp-" + randomUUID().slice(0, 8),
      name: "Stamp Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency.toUpperCase()],
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

/** Open a real (non-demo) operator session, fund its journal wallet, return the bet ctx. */
async function openOperatorSession(currency: string, playerId: string) {
  const op = await freshOperator(currency);
  const token = await launch.issue({ operatorId: op.id, playerId, currency });
  const s = await sessions.openFromToken(token);
  await prisma.wallet.update({ where: { id: s.walletId }, data: { balance: 100_000_000n } });
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: s.walletId } });
  createdUserIds.push(wallet.userId);
  return { op, userId: wallet.userId, walletId: s.walletId };
}

/** Create a guest user with a single funded wallet (no operator session). */
async function makeGuest(currency: string) {
  const user = await prisma.user.create({ data: { username: "guest:" + randomUUID(), isGuest: true } });
  createdUserIds.push(user.id);
  const wallet = await prisma.wallet.create({ data: { userId: user.id, currency, balance: 100_000_000n } });
  return { userId: user.id, walletId: wallet.id };
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
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

describe("placeBet stamp — operatorId + currency", () => {
  test("an operator bet stamps operator_id + canonical UPPERCASE currency", async () => {
    activeRoundId = await makeRound();
    const { op, userId, walletId } = await openOperatorSession("EUR", "stamp-op-player");

    const r = await bets.placeBet(userId, "A" as Panel, 1000, undefined, walletId, undefined, false, undefined, {
      operatorId: op.id,
    });
    expect(r.ok).toBe(true);

    const bet = await prisma.bet.findUniqueOrThrow({ where: { id: r.betId! } });
    expect(bet.operatorId).toBe(op.id); // stamped from the verified play token
    expect(bet.currency).toBe("EUR"); // wallet currency, canonical upper
    expect(bet.status).toBe("active");
    expect(bet.demo).toBe(false);
  });

  test("currency is upper-cased from the wallet even if the wallet stored it lowercase", async () => {
    // Defensive: a legacy lowercase wallet currency must still be stamped UPPERCASE so
    // the per-currency reporting groupBy never splits "eur" from "EUR".
    activeRoundId = await makeRound();
    const user = await prisma.user.create({ data: { username: "lc:" + randomUUID(), isGuest: false } });
    createdUserIds.push(user.id);
    const wallet = await prisma.wallet.create({ data: { userId: user.id, currency: "eur", balance: 100_000_000n } });
    const op = await freshOperator("EUR");

    const r = await bets.placeBet(user.id, "A" as Panel, 500, undefined, wallet.id, undefined, false, undefined, {
      operatorId: op.id,
    });
    expect(r.ok).toBe(true);
    const bet = await prisma.bet.findUniqueOrThrow({ where: { id: r.betId! } });
    expect(bet.currency).toBe("EUR"); // canonicalised, not "eur"
    expect(bet.operatorId).toBe(op.id);
  });

  test("a GUEST bet (no betCtx) stamps operator_id = NULL (internal behaviour unchanged)", async () => {
    activeRoundId = await makeRound();
    const { userId, walletId } = await makeGuest("DEMO");

    // No walletId + no betCtx → the pre-3.5 guest path; operatorId must be null.
    const r = await bets.placeBet(userId, "A" as Panel, 1000);
    expect(r.ok).toBe(true);

    const bet = await prisma.bet.findUniqueOrThrow({ where: { id: r.betId! } });
    expect(bet.operatorId).toBeNull(); // excluded from operator reports
    expect(bet.currency).toBe("DEMO"); // still stamped (wallet currency), uppercase
    expect(bet.walletId).toBe(walletId);
  });
});
