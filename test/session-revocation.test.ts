import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { OperatorController } from "../src/operator/operator.controller";

/**
 * Audit L-C2.2 follow-up — session revocation TRIGGER (e.g. a player logout).
 *
 * The just-landed change adds a SOFT revocation: `GameSession.revokedAt`.
 *   - `isLive(sessionId)` now filters `{ id, revokedAt: null }` → a revoked
 *     session is no longer live (the WS gateway rejects it at connect even while
 *     its short-lived JWT hasn't yet expired).
 *   - `revokeForWallet(walletId)` does `updateMany({ where:{ walletId, revokedAt:null },
 *     data:{ revokedAt: now } })` → idempotent, KEEPS the rows, returns the count.
 *   - `POST /api/operator/session/close` (controller `closeSession(walletId)`) is a
 *     logout: guest (no walletId) → `{ok:true, revoked:0}`.
 *
 * SOFT is the crux: the row is KEPT so the operator-wallet resolver still routes
 * in-flight settlement for that wallet after a revoke — a hard delete would break it.
 *
 * No engine/ledger/socket here — we drive LaunchTokenService + GameSessionService
 * directly, exactly as the C2 / L-C2 suites do.
 */

// One secret shared by issuer + the verifier we stand in for the gateway with.
// The launch token itself is signed per-operator (explicit secret); this default
// only matters for being CONSISTENT for the session ("play") token.
const JWT_SECRET = "session-revocation-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt);
const controller = new OperatorController(sessions);

// Track everything we create for FK-safe teardown + a baseline to prove we leave
// the shared dev DB exactly as we found it.
const createdOperatorIds: string[] = [];
let baselineOps = 0;
let baselineSessions = 0;
let baselineOpUsers = 0;

async function freshOperator(currency = "EUR") {
  const op = await prisma.operator.create({
    data: {
      code: "op-rev-" + randomUUID().slice(0, 8),
      name: "Revocation Test Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

/** Launch a fresh operator player and consume the token → a live session. */
async function launchPlayer(opts: { currency?: string; playerId?: string; op?: { id: string } } = {}) {
  const currency = opts.currency ?? "EUR";
  const playerId = opts.playerId ?? "player-" + randomUUID().slice(0, 8);
  const op = opts.op ?? (await freshOperator(currency));
  const launchToken = await launch.issue({ operatorId: op.id, playerId, currency, locale: "en" });
  const session = await sessions.openFromToken(launchToken);
  return { op, playerId, currency, session };
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

test("1. isLive flips true→false on revokeForWallet(walletId)", async () => {
  const { session } = await launchPlayer({ currency: "EUR" });

  // Just-opened operator session → live.
  expect(await sessions.isLive(session.sessionId)).toBe(true);

  // Revoke every live session bound to this wallet (the logout trigger). It
  // should report exactly the one session we just opened.
  const revoked = await sessions.revokeForWallet(session.walletId);
  expect(revoked).toBe(1);

  // FAILS-FIRST: pre-fix `isLive` filtered only on `{ id }`, so it stayed `true`
  // after a revoke (no `revokedAt` column existed to filter on). Now → false.
  expect(await sessions.isLive(session.sessionId)).toBe(false);
});

test("2. SOFT — the GameSession row is KEPT and the resolver still routes after revoke", async () => {
  const { op, playerId, currency, session } = await launchPlayer({ currency: "EUR" });

  const revoked = await sessions.revokeForWallet(session.walletId);
  expect(revoked).toBe(1);
  expect(await sessions.isLive(session.sessionId)).toBe(false);

  // The row must STILL EXIST (soft revoke) with revokedAt set — not hard-deleted.
  const row = await prisma.gameSession.findUnique({ where: { id: session.sessionId } });
  expect(row).not.toBeNull();
  expect(row!.revokedAt).toBeInstanceOf(Date);

  // FAILS-FIRST / teeth: the operator-wallet resolver must STILL route this
  // walletId to its operator session so in-flight settlement keeps working after
  // a revoke. A hard-delete implementation would make findFirstOrThrow throw here.
  const routed = await sessions.resolver()(session.walletId);
  expect(routed).toEqual({ operatorId: op.id, playerId, currency });
});

test("3. idempotent + multi-session: revoke returns 2 then 0; both sessions go non-live", async () => {
  // ONE operator + player+currency → both launches reuse the SAME wallet, with
  // two DISTINCT sessions (distinct launch jti each).
  const op = await freshOperator("EUR");
  const playerId = "p-multi-" + randomUUID().slice(0, 8);
  const a = await launchPlayer({ op, playerId, currency: "EUR" });
  const b = await launchPlayer({ op, playerId, currency: "EUR" });

  expect(a.session.walletId).toBe(b.session.walletId); // same wallet
  expect(a.session.sessionId).not.toBe(b.session.sessionId); // two sessions

  // Both live before revoke.
  expect(await sessions.isLive(a.session.sessionId)).toBe(true);
  expect(await sessions.isLive(b.session.sessionId)).toBe(true);

  // First revoke flips BOTH live sessions → count 2.
  expect(await sessions.revokeForWallet(a.session.walletId)).toBe(2);

  // Second revoke is idempotent: already-revoked rows are skipped → count 0.
  expect(await sessions.revokeForWallet(a.session.walletId)).toBe(0);

  // Both sessions are non-live now.
  expect(await sessions.isLive(a.session.sessionId)).toBe(false);
  expect(await sessions.isLive(b.session.sessionId)).toBe(false);
});

test("4. revoking one wallet does not touch another player's session", async () => {
  // Two independent players (distinct wallets). Revoking the first must leave the
  // second fully live (the updateMany is scoped to `walletId`).
  const first = await launchPlayer({ currency: "EUR" });
  const second = await launchPlayer({ currency: "EUR" });
  expect(first.session.walletId).not.toBe(second.session.walletId);

  expect(await sessions.isLive(first.session.sessionId)).toBe(true);
  expect(await sessions.isLive(second.session.sessionId)).toBe(true);

  const revoked = await sessions.revokeForWallet(first.session.walletId);
  expect(revoked).toBe(1); // ONLY the first wallet's session

  expect(await sessions.isLive(first.session.sessionId)).toBe(false);
  expect(await sessions.isLive(second.session.sessionId)).toBe(true); // untouched
});

test("5. controller closeSession: revokes for a wallet, no-ops for a guest", async () => {
  // The HTTP entrypoint (POST /api/operator/session/close). Call it directly with
  // the @CurrentWalletId the JwtAuthGuard would inject.
  const { session } = await launchPlayer({ currency: "EUR" });
  expect(await sessions.isLive(session.sessionId)).toBe(true);

  // Player logout: walletId present → revokes their live session.
  const res = await controller.closeSession(session.walletId);
  expect(res).toEqual({ ok: true, revoked: 1 });
  expect(await sessions.isLive(session.sessionId)).toBe(false);

  // A re-logout is idempotent (already revoked → 0).
  expect(await controller.closeSession(session.walletId)).toEqual({ ok: true, revoked: 0 });

  // Guest (no session-bound wallet) → no-op, never calls revokeForWallet.
  expect(await controller.closeSession(undefined)).toEqual({ ok: true, revoked: 0 });
});
