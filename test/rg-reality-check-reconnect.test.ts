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
import { deserializeRg } from "../src/operator/rg-config";
import { rgEvaluate } from "../src/game/game.gateway";
import { makeAudit } from "./helpers/audit";

/**
 * Audit M3 / F-067 — the reality-check HARD-PAUSE + clock must PERSIST on the GameSession
 * so they survive a socket RECONNECT (a player can't dodge a pending reality check by
 * reconnecting, and reconnecting must not reset the clock to a fresh full interval).
 *
 * The gateway is never constructed by the suite (mirrors operator-rg-enforcement.test.ts) —
 * we drive the exact methods the gateway connect/sweep/ack paths call against the real DB,
 * plus BetsService.placeBet for the actual bet-block, and the pure rgEvaluate timer:
 *   - sweep fire        → GameSessionService.markRealityCheckPending(sessionId, nextDueAt)
 *   - (re)connect reload → GameSessionService.loadRealityCheckState(sessionId)
 *   - ack                → GameSessionService.ackRealityCheck(sessionId, nextDueAt)
 *   - the bet block      → BetsService.placeBet({ rgPending }) → reality_check_pending
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();
const JWT_SECRET = "rg-reconnect-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));

let activeRoundId = "";
let phase: "betting" | "running" = "betting";
const fakeEngine: any = {
  getPublicState: () => ({ roundId: activeRoundId, phase, phaseEndsAt: Date.now() + 60_000, multiplier: 2.0, serverTime: Date.now() }),
  currentMultiplier: () => 2.0,
};
const bets = new BetsService(prisma, ledger, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];

async function makeRound(status: string): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: { epoch: 4_400_000 + Math.floor(Math.random() * 1_000_000), commitHash: "rcr-" + randomUUID(), length: 2, salt: "rcr-" + randomUUID(), status: "exhausted" },
  });
  const seed = await prisma.fairnessSeed.create({ data: { chainId: chain.id, chainIndex: 1, seedHash: "rcr-" + randomUUID() } });
  const round = await prisma.round.create({ data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status, bettingOpensAt: new Date() } });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function bettingRound() {
  phase = "betting";
  activeRoundId = await makeRound("betting");
}

async function freshOperator(rgConfig: unknown, currency = "EUR") {
  const op = await prisma.operator.create({
    data: {
      code: "op-rcr-" + randomUUID().slice(0, 8),
      name: "Reconnect RG Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
      rgConfig: rgConfig as object,
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

/** Launch + fund a real-money session and decode the play token → the RG context. */
async function openSession(rgConfig: unknown, currency = "EUR") {
  const op = await freshOperator(rgConfig, currency);
  const token = await launch.issue({ operatorId: op.id, playerId: "p-" + randomUUID().slice(0, 8), currency, locale: "en" });
  const s = await sessions.openFromToken(token);
  const payload: any = await jwt.verifyAsync(s.token!);
  await prisma.wallet.update({ where: { id: s.walletId }, data: { balance: 100_000_000n } });
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: s.walletId } });
  return {
    op,
    sessionId: s.sessionId,
    userId: wallet.userId,
    walletId: s.walletId,
    sessionStartedAt: payload.sessionStartedAt as number,
    rg: deserializeRg(payload.rg)!,
  };
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
    // F-017: child-first teardown (RESTRICT FKs) — bets/ledger/profile/wallets BEFORE users.
    for (const operatorId of createdOperatorIds) {
      const opUser = { user: { username: { startsWith: `op:${operatorId}:` } } } as const;
      await prisma.bet.deleteMany({ where: { wallet: opUser } });
      await prisma.ledgerTransaction.deleteMany({ where: { wallet: opUser } });
      await prisma.profile.deleteMany({ where: opUser });
      await prisma.wallet.deleteMany({ where: opUser });
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("M3/F-067 reality-check survives reconnect", () => {
  test("a pending check persists across a reconnect; bets stay blocked until ack; clock not reset", async () => {
    const INTERVAL = 3600;
    const s = await openSession({ realityCheckIntervalSec: INTERVAL });
    expect(s.rg.enforceRealityCheck).toBe(true);
    expect(s.rg.realityCheckIntervalSec).toBe(INTERVAL);

    // FRESH connect (no persisted state yet): load returns not-pending, no due (so the gateway
    // falls back to the token-derived due `started + interval`).
    const onFirstConnect = await sessions.loadRealityCheckState(s.sessionId);
    expect(onFirstConnect.pending).toBe(false);
    expect(onFirstConnect.dueAt).toBeUndefined();

    // --- the reality check FIRES (sweep at/after the due time) ---
    const fireNow = s.sessionStartedAt + INTERVAL * 1000 + 5;
    const decision = rgEvaluate(
      { rg: s.rg, sessionStartedAt: s.sessionStartedAt, rgRealityDueAt: s.sessionStartedAt + INTERVAL * 1000, rgPending: false, rgTimeLimitNotified: false },
      fireNow,
    );
    expect(decision.emitRealityCheck).toBe(true);
    expect(decision.nextPending).toBe(true); // enforce mode → hard pause
    const advancedDue = decision.nextDueAt!; // == fireNow + INTERVAL*1000 (advanced from NOW, not start)
    // The sweep persists the pending + advanced due on the session.
    await sessions.markRealityCheckPending(s.sessionId, advancedDue);

    // --- RECONNECT: a brand-new socket reloads the persisted state ---
    const onReconnect = await sessions.loadRealityCheckState(s.sessionId);
    // FAIL-FIRST: pre-fix the gateway blindly set rgPending=false on connect → the pause was
    // lost on reconnect. Now the persisted pending re-arms it.
    expect(onReconnect.pending).toBe(true);
    expect(onReconnect.dueAt).toBe(advancedDue);
    // The clock is NOT reset to a fresh full interval (start+interval); it resumes the advanced
    // due the sweep wrote — i.e. strictly later than the original first-due.
    expect(onReconnect.dueAt!).toBe(fireNow + INTERVAL * 1000);
    expect(onReconnect.dueAt!).toBeGreaterThan(s.sessionStartedAt + INTERVAL * 1000);

    // --- place_bet on the reconnected socket is STILL BLOCKED (rgPending restored from DB) ---
    await bettingRound();
    const blocked = await bets.placeBet(s.userId, "A" as Panel, 100, undefined, s.walletId, undefined, false, {
      rg: s.rg,
      rgPending: onReconnect.pending, // gateway sets client.data.rgPending = restored.pending
      sessionStartedAt: s.sessionStartedAt,
    });
    expect(blocked).toMatchObject({ ok: false, reason: "reality_check_pending" });

    // --- the player ACKNOWLEDGES (the only way to lift the pause) ---
    const ackDue = Date.now() + INTERVAL * 1000;
    await sessions.ackRealityCheck(s.sessionId, ackDue);
    const afterAck = await sessions.loadRealityCheckState(s.sessionId);
    expect(afterAck.pending).toBe(false); // pause cleared
    expect(afterAck.dueAt).toBe(ackDue); // due advanced from the ack
    // The ack timestamp is recorded.
    const row = await prisma.gameSession.findUniqueOrThrow({ where: { id: s.sessionId } });
    expect(row.realityCheckLastAckAt).toBeInstanceOf(Date);
    expect(row.realityCheckPendingAt).toBeNull();

    // --- a reconnect AFTER ack reloads a NON-pending state → bets allowed again ---
    const afterAckReconnect = await sessions.loadRealityCheckState(s.sessionId);
    await bettingRound();
    const allowed = await bets.placeBet(s.userId, "A" as Panel, 100, undefined, s.walletId, undefined, false, {
      rg: s.rg,
      rgPending: afterAckReconnect.pending,
      sessionStartedAt: s.sessionStartedAt,
    });
    expect(allowed.ok).toBe(true);
  });

  test("notify mode persists the advanced due but never a pending pause", async () => {
    const INTERVAL = 1800;
    const s = await openSession({ realityCheckIntervalSec: INTERVAL, enforceRealityCheck: false });
    expect(s.rg.enforceRealityCheck).toBe(false);

    const fireNow = s.sessionStartedAt + INTERVAL * 1000 + 5;
    const decision = rgEvaluate(
      { rg: s.rg, sessionStartedAt: s.sessionStartedAt, rgRealityDueAt: s.sessionStartedAt + INTERVAL * 1000, rgPending: false, rgTimeLimitNotified: false },
      fireNow,
    );
    expect(decision.emitRealityCheck).toBe(true);
    expect(decision.nextPending).toBe(false); // notify mode → no pause

    // The gateway persists via ackRealityCheck in notify mode (advance the clock, no pending).
    await sessions.ackRealityCheck(s.sessionId, decision.nextDueAt);
    const onReconnect = await sessions.loadRealityCheckState(s.sessionId);
    expect(onReconnect.pending).toBe(false);
    expect(onReconnect.dueAt).toBe(fireNow + INTERVAL * 1000);

    // A reconnect in notify mode is never blocked.
    await bettingRound();
    const r = await bets.placeBet(s.userId, "A" as Panel, 100, undefined, s.walletId, undefined, false, {
      rg: s.rg,
      rgPending: onReconnect.pending,
      sessionStartedAt: s.sessionStartedAt,
    });
    expect(r.ok).toBe(true);
  });

  test("loadRealityCheckState for a revoked/absent session is non-pending", async () => {
    const s = await openSession({ realityCheckIntervalSec: 3600 });
    await sessions.markRealityCheckPending(s.sessionId, Date.now() + 3600_000);
    // A non-existent session id → not pending, no due (guests / deleted rows).
    const missing = await sessions.loadRealityCheckState(randomUUID());
    expect(missing).toEqual({ pending: false });
  });
});
