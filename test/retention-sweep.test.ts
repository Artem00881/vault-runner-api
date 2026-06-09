import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { WalletRouter } from "../src/wallet/wallet-router";
import { SeamlessOperatorWallet } from "../src/wallet/seamless-operator-wallet";
import { AuditEventService } from "../src/audit/audit-event.service";
import { DataErasureService } from "../src/privacy/data-erasure.service";
import { MockOperator } from "./helpers/mock-operator";
import { makeAudit } from "./helpers/audit";

/**
 * GDPR + caps batch — RETENTION SWEEP (R-038):
 *   - DataErasureService.findDormantPlayers(cutoff) — the pure read that enumerates DORMANT
 *     operator players (src/privacy/data-erasure.service.ts);
 *   - the sweep's policy guards + apply behaviour (scripts/retention-sweep.ts).
 *
 * findDormantPlayers + anonymizePlayer are exercised directly against the DB (the script is just
 * an arg-parsing + logging shell around them). The retention-window guard (resolveRetentionDays)
 * is module-private to the script, so — exactly as operator-auth-guard.test.ts does for the
 * throttler's private numEnv — we pin its DOCUMENTED CONTRACT against a faithful copy of the
 * one-liner, and assert the WHOLE-WINDOW invariant (a 0/NaN window must NOT erase everyone) via
 * findDormantPlayers itself.
 *
 * Players are created through the REAL launch path (so GameSessions exist with controllable
 * createdAt), mirroring data-erasure.test.ts wiring. Needs docker Postgres+Redis. FK-safe,
 * tracked-id teardown.
 */

const JWT_SECRET = "retention-sweep-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));

const operatorApi = new MockOperator();
const seamless = new SeamlessOperatorWallet(operatorApi, sessions.resolver());
const router = new WalletRouter(ledger, seamless, (walletId) => sessions.isDemoWallet(walletId));

let activeRoundId = "";
let phase: "betting" | "running" = "betting";
let liveMult = 2.0;
const fakeEngine: any = {
  getPublicState: () => ({ roundId: activeRoundId, phase, phaseEndsAt: Date.now() + 60_000, multiplier: liveMult, serverTime: Date.now() }),
  currentMultiplier: () => liveMult,
};
const bets = new BetsService(prisma, router, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

const audit = new AuditEventService(prisma, metrics);
const erasure = new DataErasureService(prisma, audit, metrics);

const DAY = 24 * 60 * 60 * 1000;

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdOperatorIds: string[] = [];
const createdWalletIds: string[] = [];
const createdUserIds: string[] = [];

async function makeRound(status: string): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: { epoch: 6_900_000 + Math.floor(Math.random() * 1_000_000), commitHash: "rs-" + randomUUID(), length: 2, salt: "rs-" + randomUUID(), status: "exhausted" },
  });
  const seed = await prisma.fairnessSeed.create({ data: { chainId: chain.id, chainIndex: 1, seedHash: "rs-" + randomUUID() } });
  const round = await prisma.round.create({ data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status, bettingOpensAt: new Date() } });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** A dedicated operator per test (so findDormantPlayers's whole-table scan can be SCOPED to it). */
async function freshOperator() {
  const op = await prisma.operator.create({
    data: { code: "op-rs-" + randomUUID().slice(0, 8), name: "Retention Operator", enabled: true, demoEnabled: false, launchSecret: "secret-" + randomUUID(), currencies: ["EUR"] },
  });
  createdOperatorIds.push(op.id);
  return op.id;
}

/** Launch a REAL player and seed its operator balance; returns its ids. */
async function launchPlayer(operatorId: string, playerId: string, operatorBalance = 100_000) {
  const token = await launch.issue({ operatorId, playerId, currency: "EUR" });
  const s = await sessions.openFromToken(token);
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: s.walletId } });
  operatorApi.seed(playerId, "EUR", operatorBalance);
  createdWalletIds.push(s.walletId);
  createdUserIds.push(wallet.userId);
  return { playerId, walletId: s.walletId, userId: wallet.userId, sessionId: s.sessionId };
}

/** Backdate a session's createdAt to `ageDays` ago (and revoke it so it isn't a live-session block). */
async function ageSession(sessionId: string, ageDays: number) {
  await prisma.gameSession.update({ where: { id: sessionId }, data: { createdAt: new Date(Date.now() - ageDays * DAY), revokedAt: new Date(Date.now() - ageDays * DAY) } });
}

/** Place + bust a bet (terminal) with createdAt backdated to `ageDays` ago. */
async function placeBustedBetAged(userId: string, walletId: string, ageDays: number): Promise<string> {
  phase = "betting";
  activeRoundId = await makeRound("betting");
  const placed = await bets.placeBet(userId, "A", 1000, undefined, walletId);
  expect(placed.ok).toBe(true);
  await bets.settleRound(activeRoundId); // busted (terminal)
  await prisma.bet.update({ where: { id: placed.betId! }, data: { createdAt: new Date(Date.now() - ageDays * DAY) } });
  return placed.betId!;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  try {
    if (createdWalletIds.length) await prisma.bet.deleteMany({ where: { walletId: { in: createdWalletIds } } });
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdWalletIds.length) await prisma.ledgerTransaction.deleteMany({ where: { walletId: { in: createdWalletIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    if (createdUserIds.length) await prisma.profile.deleteMany({ where: { userId: { in: createdUserIds } } });
    if (createdWalletIds.length) await prisma.wallet.deleteMany({ where: { id: { in: createdWalletIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DataErasureService.findDormantPlayers — dormant enumeration (R-038, pure read)", () => {
  test("a player with ONLY an OLD session is listed; an old session + RECENT bet is excluded; an already-anonymized player is filtered out", async () => {
    const operatorId = await freshOperator();
    const cutoff = new Date(Date.now() - 365 * DAY); // 1-year retention window

    // (a) DORMANT: only an old session (400d ago), no bets → listed.
    const dormant = await launchPlayer(operatorId, "dormant-" + randomUUID().slice(0, 6));
    await ageSession(dormant.sessionId, 400);

    // (b) ACTIVE-VIA-BET: old session (400d) but a RECENT bet (1d ago) → excluded (conservative).
    const recentBet = await launchPlayer(operatorId, "recentbet-" + randomUUID().slice(0, 6));
    await placeBustedBetAged(recentBet.userId, recentBet.walletId, 1); // bet 1d ago
    await ageSession(recentBet.sessionId, 400); // session itself is old

    // (c) ALREADY-ANONYMIZED: old session, then erased → filtered out (no re-listing on a re-run).
    const erased = await launchPlayer(operatorId, "erased-" + randomUUID().slice(0, 6));
    await ageSession(erased.sessionId, 400);
    await erasure.anonymizePlayer({ operatorId, playerId: erased.playerId, actor: "test-setup" });

    const found = await erasure.findDormantPlayers(cutoff);
    const forOp = found.filter((d) => d.operatorId === operatorId);
    const ids = forOp.map((d) => d.playerId);

    // (a) listed; (b) + (c) absent.
    expect(ids).toContain(dormant.playerId);
    expect(ids).not.toContain(recentBet.playerId);
    // (c) — the anonymized player's session.playerId is `anon:{tombstone}`, never the raw id.
    expect(ids).not.toContain(erased.playerId);
    expect(ids.some((id) => id.startsWith("anon:"))).toBe(false);

    // The dormant entry carries its lastActivity (the old session time), strictly before the cutoff.
    const dormantEntry = forOp.find((d) => d.playerId === dormant.playerId)!;
    expect(dormantEntry.lastActivity.getTime()).toBeLessThan(cutoff.getTime());
  });

  test("a session right AT/inside the window is NOT dormant (boundary: strictly-before)", async () => {
    const operatorId = await freshOperator();
    // Window 365d. A session 364d old is INSIDE the window → not dormant. A 366d session IS.
    const inside = await launchPlayer(operatorId, "inside-" + randomUUID().slice(0, 6));
    await ageSession(inside.sessionId, 364);
    const outside = await launchPlayer(operatorId, "outside-" + randomUUID().slice(0, 6));
    await ageSession(outside.sessionId, 366);

    const cutoff = new Date(Date.now() - 365 * DAY);
    const ids = (await erasure.findDormantPlayers(cutoff)).filter((d) => d.operatorId === operatorId).map((d) => d.playerId);
    expect(ids).not.toContain(inside.playerId);
    expect(ids).toContain(outside.playerId);
  });

  test("a player with an OLD session AND old bets (both past the window) IS dormant", async () => {
    const operatorId = await freshOperator();
    const p = await launchPlayer(operatorId, "alldold-" + randomUUID().slice(0, 6));
    await placeBustedBetAged(p.userId, p.walletId, 400); // bet 400d ago
    await ageSession(p.sessionId, 400); // session 400d ago

    const cutoff = new Date(Date.now() - 365 * DAY);
    const ids = (await erasure.findDormantPlayers(cutoff)).filter((d) => d.operatorId === operatorId).map((d) => d.playerId);
    expect(ids).toContain(p.playerId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("retention sweep — policy guard + apply behaviour (R-038)", () => {
  /**
   * Faithful copy of scripts/retention-sweep.ts::resolveRetentionDays (module-private). The point:
   * a 0 / negative / NaN / non-integer window is REFUSED so a misconfigured sweep can never erase
   * EVERYONE (cutoff = now, every player dormant). Mirrored exactly per the auth-guard precedent.
   */
  function resolveRetentionDays(args: Record<string, string | boolean>): number {
    const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);
    const raw = str(args.days) ?? process.env.RETENTION_DAYS;
    if (raw === undefined) return 365;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      throw new Error(`invalid retention window "${raw}" — RETENTION_DAYS/--days must be an integer >= 1`);
    }
    return n;
  }

  const SAVED_RETENTION = process.env.RETENTION_DAYS;
  function withRetentionEnv(v: string | undefined, fn: () => void) {
    if (v === undefined) delete process.env.RETENTION_DAYS;
    else process.env.RETENTION_DAYS = v;
    try {
      fn();
    } finally {
      if (SAVED_RETENTION === undefined) delete process.env.RETENTION_DAYS;
      else process.env.RETENTION_DAYS = SAVED_RETENTION;
    }
  }

  test("resolveRetentionDays REFUSES 0 / negative / NaN / non-integer (a 0 window must NOT erase everyone)", () => {
    // Via --days (CLI wins): every unsafe window throws — never silently becomes a 0-day cutoff.
    for (const bad of ["0", "-1", "-365", "NaN", "abc", "", "1.5", "Infinity", "-Infinity"]) {
      expect(() => resolveRetentionDays({ days: bad })).toThrow(/invalid retention window/);
    }
    // Via the env, same refusal.
    withRetentionEnv("0", () => expect(() => resolveRetentionDays({})).toThrow(/invalid retention window/));
    withRetentionEnv("-5", () => expect(() => resolveRetentionDays({})).toThrow(/invalid retention window/));
    withRetentionEnv("NaN", () => expect(() => resolveRetentionDays({})).toThrow(/invalid retention window/));

    // Valid windows pass through; unset → the safe 365 default; --days beats the env.
    expect(resolveRetentionDays({ days: "365" })).toBe(365);
    expect(resolveRetentionDays({ days: "1" })).toBe(1);
    withRetentionEnv(undefined, () => expect(resolveRetentionDays({})).toBe(365));
    withRetentionEnv("730", () => {
      expect(resolveRetentionDays({})).toBe(730); // env honoured
      expect(resolveRetentionDays({ days: "90" })).toBe(90); // --days overrides the env
    });
  });

  test("DRY-RUN behaviour: findDormantPlayers (the dry-run read) mutates NOTHING", async () => {
    const operatorId = await freshOperator();
    const p = await launchPlayer(operatorId, "dryrun-" + randomUUID().slice(0, 6));
    await placeBustedBetAged(p.userId, p.walletId, 400);
    await ageSession(p.sessionId, 400);

    const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: p.userId } });
    const sessionBefore = await prisma.gameSession.findUniqueOrThrow({ where: { id: p.sessionId } });
    const betsBefore = await prisma.bet.findMany({ where: { walletId: p.walletId }, select: { id: true, status: true, amount: true } });
    const auditBefore = await prisma.auditEvent.count({ where: { operatorId, action: "player.anonymize" } });

    // The dry-run path lists candidates and returns — calling ONLY findDormantPlayers.
    const cutoff = new Date(Date.now() - 365 * DAY);
    const candidates = (await erasure.findDormantPlayers(cutoff)).filter((d) => d.operatorId === operatorId);
    expect(candidates.map((c) => c.playerId)).toContain(p.playerId); // it WOULD be erased

    // …but NOTHING changed: username/displayName/session.playerId/anonymizedAt + bets + audit.
    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: p.userId } });
    expect(userAfter.username).toBe(userBefore.username);
    expect(userAfter.username.startsWith("op:")).toBe(true);
    expect(userAfter.anonymizedAt).toBeNull();
    const sessionAfter = await prisma.gameSession.findUniqueOrThrow({ where: { id: p.sessionId } });
    expect(sessionAfter.playerId).toBe(sessionBefore.playerId);
    expect(sessionAfter.playerId.startsWith("anon:")).toBe(false);
    expect(await prisma.bet.findMany({ where: { walletId: p.walletId }, select: { id: true, status: true, amount: true } })).toEqual(betsBefore);
    expect(await prisma.auditEvent.count({ where: { operatorId, action: "player.anonymize" } })).toBe(auditBefore);
  });

  test("APPLY: a player that became NON-SETTLED between scan and apply is SKIPPED (player_not_settled), never force-erased", async () => {
    const operatorId = await freshOperator();
    const cutoff = new Date(Date.now() - 365 * DAY);

    // Two dormant players. One stays settled; the other gains an in-flight (active) bet AFTER the
    // scan — exactly the scan→apply race the sweep must survive without force-erasing.
    const settled = await launchPlayer(operatorId, "settled-" + randomUUID().slice(0, 6));
    await ageSession(settled.sessionId, 400);

    const racer = await launchPlayer(operatorId, "racer-" + randomUUID().slice(0, 6));
    await ageSession(racer.sessionId, 400);

    // SCAN: both are dormant candidates.
    const candidates = (await erasure.findDormantPlayers(cutoff)).filter((d) => d.operatorId === operatorId);
    const cand = candidates.map((c) => c.playerId);
    expect(cand).toContain(settled.playerId);
    expect(cand).toContain(racer.playerId);

    // BETWEEN SCAN AND APPLY: the racer places a fresh, in-flight (active = non-terminal) bet.
    phase = "betting";
    activeRoundId = await makeRound("betting");
    const placed = await bets.placeBet(racer.userId, "A", 1000, undefined, racer.walletId);
    expect(placed.ok).toBe(true); // status: active (non-terminal)

    // APPLY: the same fail-closed path the sweep uses. The racer throws player_not_settled (SKIP),
    // the settled player is erased. The sweep catches that one error and force-erases NOTHING.
    let racerSkipped = false;
    try {
      await erasure.anonymizePlayer({ operatorId, playerId: racer.playerId, actor: "retention-sweep" });
    } catch (e: any) {
      const msg = e?.response?.message ?? e?.message ?? String(e);
      racerSkipped = msg === "player_not_settled";
    }
    expect(racerSkipped).toBe(true);

    const settledResult = await erasure.anonymizePlayer({ operatorId, playerId: settled.playerId, actor: "retention-sweep" });
    expect(settledResult.alreadyAnonymized).toBe(false);
    expect(settledResult.usersAffected).toBe(1);

    // The racer is UNTOUCHED (its PII + its live bet survive); the settled player is tombstoned.
    const racerUser = await prisma.user.findUniqueOrThrow({ where: { id: racer.userId } });
    expect(racerUser.username.startsWith("op:")).toBe(true);
    expect(racerUser.anonymizedAt).toBeNull();
    expect(await prisma.bet.count({ where: { walletId: racer.walletId, status: "active" } })).toBe(1);
    const settledUser = await prisma.user.findUniqueOrThrow({ where: { id: settled.userId } });
    expect(settledUser.username.startsWith("anon:")).toBe(true);
    expect(settledUser.anonymizedAt).not.toBeNull();
  });

  test("APPLY: a player with a LIVE session (revokedAt null) is also SKIPPED, not force-erased", async () => {
    const operatorId = await freshOperator();
    const cutoff = new Date(Date.now() - 365 * DAY);
    // Old session by createdAt, but STILL LIVE (revokedAt null) — dormant by recency yet in-flight.
    const live = await launchPlayer(operatorId, "live-" + randomUUID().slice(0, 6));
    await prisma.gameSession.update({ where: { id: live.sessionId }, data: { createdAt: new Date(Date.now() - 400 * DAY) } }); // NOT revoked

    expect((await erasure.findDormantPlayers(cutoff)).filter((d) => d.operatorId === operatorId).map((d) => d.playerId)).toContain(live.playerId);

    let skipped = false;
    try {
      await erasure.anonymizePlayer({ operatorId, playerId: live.playerId, actor: "retention-sweep" });
    } catch (e: any) {
      skipped = (e?.response?.message ?? e?.message ?? String(e)) === "player_not_settled";
    }
    expect(skipped).toBe(true);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: live.userId } });
    expect(u.username.startsWith("op:")).toBe(true);
    expect(u.anonymizedAt).toBeNull();
  });
});
