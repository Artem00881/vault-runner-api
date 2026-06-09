import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { makeAudit } from "./helpers/audit";

const prisma = new PrismaService();
// A default secret so GameSessionService can sign the session ("play") token;
// LaunchTokenService passes the per-operator secret explicitly, overriding this.
const jwt = new JwtService({ secret: "test-secret" });
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));

// Operators created by the playerId-cap suite below — cleaned up FK-safe in afterAll.
const capOperatorIds: string[] = [];

async function freshOperator(enabled = true) {
  return prisma.operator.create({
    data: {
      code: "op-" + randomUUID().slice(0, 8),
      name: "Test Operator",
      enabled,
      launchSecret: "secret-" + randomUUID(),
      currencies: ["EUR"],
    },
  });
}

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  // FK-safe teardown for the operators the playerId-cap suite created (child rows first).
  try {
    for (const operatorId of capOperatorIds) {
      const opUser = { user: { username: { startsWith: `op:${operatorId}:` } } } as const;
      await prisma.bet.deleteMany({ where: { wallet: opUser } });
      await prisma.ledgerTransaction.deleteMany({ where: { wallet: opUser } });
      await prisma.profile.deleteMany({ where: opUser });
      await prisma.wallet.deleteMany({ where: opUser });
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (capOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: capOperatorIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

test("valid launch token opens a session and the resolver maps wallet → operator player", async () => {
  const op = await freshOperator();
  const token = await launch.issue({ operatorId: op.id, playerId: "player-1", currency: "EUR", locale: "en" });

  const session = await sessions.openFromToken(token);
  expect(session.currency).toBe("EUR");
  expect(session.walletId).toBeTruthy();

  const resolved = await sessions.resolver()(session.walletId);
  expect(resolved.operatorId).toBe(op.id);
  expect(resolved.playerId).toBe("player-1");
  expect(resolved.currency).toBe("EUR");
});

test("forged token (wrong secret) is rejected", async () => {
  const op = await freshOperator();
  // sign with a DIFFERENT secret than the operator's
  const forged = await jwt.signAsync(
    { operatorId: op.id, playerId: "p", currency: "EUR", locale: "en" },
    { secret: "not-the-operator-secret", expiresIn: 120, jwtid: randomUUID() },
  );
  await expect(sessions.openFromToken(forged)).rejects.toThrow("invalid_launch_token");
});

test("replayed token (same jti used twice) is rejected — one-time use", async () => {
  const op = await freshOperator();
  const token = await launch.issue({ operatorId: op.id, playerId: "player-2", currency: "EUR" });
  await sessions.openFromToken(token); // first use ok
  await expect(sessions.openFromToken(token)).rejects.toThrow("launch_token_already_used");
});

test("expired token is rejected", async () => {
  const op = await freshOperator();
  // sign already-expired with the operator's real secret
  const expired = await jwt.signAsync(
    { operatorId: op.id, playerId: "p", currency: "EUR", locale: "en" },
    { secret: op.launchSecret, expiresIn: -10, jwtid: randomUUID() },
  );
  await expect(sessions.openFromToken(expired)).rejects.toThrow("invalid_launch_token");
});

test("disabled operator is rejected", async () => {
  const op = await freshOperator(false);
  const token = await jwt.signAsync(
    { operatorId: op.id, playerId: "p", currency: "EUR", locale: "en" },
    { secret: op.launchSecret, expiresIn: 120, jwtid: randomUUID() },
  );
  await expect(sessions.openFromToken(token)).rejects.toThrow("unknown_operator");
});

test("returning player reuses the same local journal wallet", async () => {
  const op = await freshOperator();
  const t1 = await launch.issue({ operatorId: op.id, playerId: "player-3", currency: "EUR" });
  const s1 = await sessions.openFromToken(t1);
  const t2 = await launch.issue({ operatorId: op.id, playerId: "player-3", currency: "EUR" });
  const s2 = await sessions.openFromToken(t2);
  expect(s2.walletId).toBe(s1.walletId); // same wallet across launches
});

/**
 * GDPR + caps batch (#1) — launch-token playerId CAP in LaunchTokenService.verify().
 *
 * The playerId is the one operator-SUPPLIED free string we accept INBOUND that flows into the
 * persisted, UNIQUE username tag (`op:{operatorId}:{playerId}:{currency}`) and every per-operator
 * index lookup. verify() now rejects a missing / non-string / empty / >200-char playerId with
 * `invalid_launch_token` — and crucially does so BEFORE the jti is consumed (no GameSession is
 * written), so the operator can re-issue a corrected token. We pin both the rejection AND the
 * "jti not consumed" property (a corrected re-issue still opens a session, and no session was
 * created for the rejected token).
 *
 * The over-long / non-string tokens are signed DIRECTLY with the operator's secret (issue() takes
 * the playerId verbatim), so the payload is fully controlled — mirrors the forged/expired tests.
 */
describe("#1 launch-token playerId cap (verify)", () => {
  const MAX = 200;

  async function capOperator() {
    const op = await freshOperator();
    capOperatorIds.push(op.id);
    return op;
  }

  // Sign a launch token with an ARBITRARY playerId payload (bypassing issue()'s typing) so we can
  // exercise missing / non-string / over-long ids. Distinct jti each time.
  function signWith(op: { id: string; launchSecret: string }, playerId: unknown) {
    return jwt.signAsync(
      { operatorId: op.id, playerId, currency: "EUR", locale: "en" },
      { secret: op.launchSecret, expiresIn: 120, jwtid: randomUUID() },
    );
  }

  test("table-driven: missing / non-string / empty / >200-char playerId → invalid_launch_token, jti NOT consumed", async () => {
    const op = await capOperator();
    const cases: Array<{ name: string; playerId: unknown }> = [
      { name: "missing (undefined)", playerId: undefined },
      { name: "null", playerId: null },
      { name: "number", playerId: 12345 },
      { name: "boolean", playerId: true },
      { name: "object", playerId: { id: "x" } },
      { name: "array", playerId: ["a"] },
      { name: "empty string", playerId: "" },
      { name: "201 chars (one over the cap)", playerId: "x".repeat(MAX + 1) },
      { name: "10k chars", playerId: "y".repeat(10_000) },
    ];
    for (const c of cases) {
      const token = await signWith(op, c.playerId);
      const jti = (jwt.decode(token) as any).jti as string;

      // Rejected with the generic invalid_launch_token (no oracle, before jti consumption).
      let err: unknown;
      try {
        await sessions.openFromToken(token);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UnauthorizedException);
      const body: any = (err as UnauthorizedException).getResponse();
      expect(typeof body === "string" ? body : body.message).toBe("invalid_launch_token");

      // jti NOT consumed: no GameSession was written for this token.
      expect(await prisma.gameSession.count({ where: { launchJti: jti } })).toBe(0);
    }
  });

  test("a rejected over-long launch does not burn the player — a CORRECTED re-issue (≤200) still opens a session", async () => {
    const op = await capOperator();
    const playerId = "p-" + randomUUID().slice(0, 8);

    // First: an over-long playerId for this same logical player → rejected, no session, no wallet.
    const bad = await signWith(op, playerId + "-" + "z".repeat(MAX)); // > 200
    await expect(sessions.openFromToken(bad)).rejects.toThrow("invalid_launch_token");
    const badJti = (jwt.decode(bad) as any).jti as string;
    expect(await prisma.gameSession.count({ where: { launchJti: badJti } })).toBe(0);

    // Then: a corrected token (a valid ≤200 playerId, fresh jti) opens a session normally — the
    // earlier rejection consumed nothing.
    const good = await launch.issue({ operatorId: op.id, playerId, currency: "EUR" });
    const s = await sessions.openFromToken(good);
    expect(s.walletId).toBeTruthy();
    const goodJti = (jwt.decode(good) as any).jti as string;
    expect(await prisma.gameSession.count({ where: { launchJti: goodJti } })).toBe(1);
  });

  test("boundary: exactly 200 chars is ACCEPTED (opens a session); 1 char is accepted", async () => {
    const op = await capOperator();
    // Exactly at the cap — accepted.
    const at = await launch.issue({ operatorId: op.id, playerId: "a".repeat(MAX), currency: "EUR" });
    const sAt = await sessions.openFromToken(at);
    expect(sAt.walletId).toBeTruthy();
    // A single-char id (the min) — accepted.
    const one = await launch.issue({ operatorId: op.id, playerId: "b", currency: "EUR" });
    const sOne = await sessions.openFromToken(one);
    expect(sOne.walletId).toBeTruthy();
  });
});
