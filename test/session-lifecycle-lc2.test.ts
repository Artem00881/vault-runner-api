import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { makeAudit } from "./helpers/audit";

/**
 * Audit L-C2.1 + L-C2.2 — operator session-lifecycle hardening.
 *
 *  L-C2.1 — idempotent FIRST launch. Two concurrent first launches for the SAME
 *  brand-new (operatorId, playerId, currency) must BOTH succeed: the journal
 *  user+wallet username is UNIQUE, so the losing user.create hits P2002 and is
 *  now caught + re-found instead of 500-ing the second launch.
 *
 *  L-C2.2 — short session-token TTL: the issued play ("session") token must be
 *  SHORT-lived (default 4h = 14400s), not the 30-day guest default (2592000s),
 *  so a leaked session token is only briefly usable.
 *
 *  L-C2.2 — isLive(sessionId): the WS gateway re-validates an operator session
 *  token against a LIVE GameSession at connect, so a revoked/removed session is
 *  rejected even while the (short-lived) JWT itself hasn't yet expired.
 *
 * No engine/ledger/socket here — we drive LaunchTokenService + GameSessionService
 * directly, exactly as the C2/launch-token suites do.
 */

// One secret shared by issuer + the verifier we stand in for the gateway with.
// The launch token itself is signed per-operator (explicit secret); this default
// only matters for being CONSISTENT for the session ("play") token.
const JWT_SECRET = "lc2-session-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));

// Track everything we create for FK-safe teardown + a baseline to prove we
// leave the shared dev DB exactly as we found it.
const createdOperatorIds: string[] = [];
let baselineOps = 0;
let baselineSessions = 0;
let baselineOpUsers = 0;

async function freshOperator(currency = "EUR") {
  const op = await prisma.operator.create({
    data: {
      code: "op-lc2-" + randomUUID().slice(0, 8),
      name: "LC2 Test Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

beforeAll(async () => {
  await prisma.$connect();
  baselineOps = await prisma.operator.count();
  baselineSessions = await prisma.gameSession.count();
  baselineOpUsers = await prisma.user.count({ where: { username: { startsWith: "op:" } } });
});

afterAll(async () => {
  // FK-safe: deleting the operator cascades its GameSessions (onDelete: Cascade);
  // the journal users we created (username tagged `op:<operatorId>:…`) cascade
  // their wallets/ledger/profile. Do users-by-tag first, then operators.
  for (const operatorId of createdOperatorIds) {
    await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
  }
  if (createdOperatorIds.length) {
    await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  }

  // Prove we left no leftover rows: every count is back to the pre-suite baseline.
  expect(await prisma.operator.count()).toBe(baselineOps);
  expect(await prisma.gameSession.count()).toBe(baselineSessions);
  expect(await prisma.user.count({ where: { username: { startsWith: "op:" } } })).toBe(baselineOpUsers);

  await prisma.$disconnect();
});

test("L-C2.1 — two concurrent FIRST launches for the same new player are idempotent (both ok, one user/wallet, two sessions)", async () => {
  // ONE operator; a brand-new player+currency (no prior user/wallet/session).
  const op = await freshOperator("EUR");
  const playerId = "p-concurrent-" + randomUUID().slice(0, 8);
  const currency = "EUR";
  const tag = `op:${op.id}:${playerId}:${currency}`;

  // TWO DIFFERENT launch tokens (issue mints a fresh random jti each time) for
  // the SAME (operatorId, playerId, currency).
  const tokenA = await launch.issue({ operatorId: op.id, playerId, currency, locale: "en" });
  const tokenB = await launch.issue({ operatorId: op.id, playerId, currency, locale: "en" });
  expect(tokenA).not.toBe(tokenB);

  // Race them. On pre-L-C2.1 code the losing user.create throws P2002 and one
  // openFromToken rejects (Promise.all surfaces it).
  const [a, b] = await Promise.all([
    sessions.openFromToken(tokenA),
    sessions.openFromToken(tokenB),
  ]);

  // BOTH resolved ok.
  expect(a.walletId).toBeTruthy();
  expect(b.walletId).toBeTruthy();
  // Same journal wallet (one operator player+currency → one wallet).
  expect(a.walletId).toBe(b.walletId);
  // Distinct sessions (distinct jti each).
  expect(a.sessionId).not.toBe(b.sessionId);

  // Exactly ONE journal user + ONE wallet for this player; TWO sessions.
  expect(await prisma.user.count({ where: { username: tag } })).toBe(1);
  const userId = (await prisma.wallet.findFirstOrThrow({ where: { user: { username: tag } } })).userId;
  expect(await prisma.wallet.count({ where: { userId } })).toBe(1);
  expect(await prisma.gameSession.count({ where: { walletId: a.walletId } })).toBe(2);
});

test("L-C2.1 — race run repeatedly stays idempotent (a few fresh players)", async () => {
  // The single race above can in principle interleave so neither hits P2002 on a
  // given run; repeat with fresh players to make the regression reliably catchable
  // (pre-fix, any run where the losing create lands second throws).
  for (let i = 0; i < 5; i++) {
    const op = await freshOperator("USD");
    const playerId = `p-race-${i}-` + randomUUID().slice(0, 8);
    const currency = "USD";
    const tag = `op:${op.id}:${playerId}:${currency}`;

    const t1 = await launch.issue({ operatorId: op.id, playerId, currency });
    const t2 = await launch.issue({ operatorId: op.id, playerId, currency });

    const [r1, r2] = await Promise.all([
      sessions.openFromToken(t1),
      sessions.openFromToken(t2),
    ]);

    expect(r1.walletId).toBe(r2.walletId);
    expect(r1.sessionId).not.toBe(r2.sessionId);
    expect(await prisma.user.count({ where: { username: tag } })).toBe(1);
    expect(await prisma.gameSession.count({ where: { walletId: r1.walletId } })).toBe(2);
  }
});

test("L-C2.1 — a sequential SECOND first-launch (after one already exists) still succeeds", async () => {
  // Non-racy path through the same find-or-create: the second launch must find
  // the existing user/wallet and NOT attempt a duplicate create.
  const op = await freshOperator("EUR");
  const playerId = "p-seq-" + randomUUID().slice(0, 8);
  const currency = "EUR";
  const tag = `op:${op.id}:${playerId}:${currency}`;

  const s1 = await sessions.openFromToken(await launch.issue({ operatorId: op.id, playerId, currency }));
  const s2 = await sessions.openFromToken(await launch.issue({ operatorId: op.id, playerId, currency }));

  expect(s2.walletId).toBe(s1.walletId);
  expect(await prisma.user.count({ where: { username: tag } })).toBe(1);
  expect(await prisma.gameSession.count({ where: { walletId: s1.walletId } })).toBe(2);
});

test("L-C2.2 — session ('play') token is SHORT-lived: exp - iat === 14400 (~4h), far below the 30-day default", async () => {
  const op = await freshOperator("EUR");
  const token = (await sessions.openFromToken(
    await launch.issue({ operatorId: op.id, playerId: "p-ttl-" + randomUUID().slice(0, 8), currency: "EUR" }),
  )).token!;
  expect(typeof token).toBe("string");

  // Decode (no verify needed) and read the JWT lifetime.
  const decoded = jwt.decode(token) as { iat: number; exp: number };
  expect(decoded.iat).toBeGreaterThan(0);
  expect(decoded.exp).toBeGreaterThan(decoded.iat);

  const lifetime = decoded.exp - decoded.iat;
  // The hardened default (audit L-C2.2). Pre-fix this was 2592000 ("30d").
  expect(lifetime).toBe(14400);
  // And explicitly: orders of magnitude below the 30-day guest default.
  const THIRTY_DAYS = 30 * 24 * 60 * 60; // 2592000
  expect(lifetime).toBeLessThan(THIRTY_DAYS);
  expect(THIRTY_DAYS / lifetime).toBeGreaterThan(100); // ~180x shorter
});

test("L-C2.2 — isLive: true for a live session, false for unknown id, false after the session is deleted (revocation)", async () => {
  const op = await freshOperator("EUR");
  const session = await sessions.openFromToken(
    await launch.issue({ operatorId: op.id, playerId: "p-live-" + randomUUID().slice(0, 8), currency: "EUR" }),
  );

  // Just-created session → live.
  expect(await sessions.isLive(session.sessionId)).toBe(true);

  // A random (never-created) session id → not live.
  expect(await sessions.isLive(randomUUID())).toBe(false);

  // Revoke by removing the GameSession row → no longer live (the gateway hook
  // that downgrades such a socket to read-only).
  await prisma.gameSession.delete({ where: { id: session.sessionId } });
  expect(await sessions.isLive(session.sessionId)).toBe(false);
});
