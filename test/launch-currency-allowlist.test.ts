import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LedgerService } from "../src/wallet/ledger.service";

/**
 * Phase 3, piece 1 — operator allowed-currency enforcement in
 * LaunchTokenService.verify().
 *
 * After signature + expiry verify (and BEFORE the jti is consumed), verify()
 * rejects with UnauthorizedException("currency_not_allowed") when the token's
 * currency isn't in op.currencies. Invariants under test:
 *
 *  - a token for an ALLOWED currency verifies OK (returns the claims);
 *  - a token for a DISALLOWED currency throws currency_not_allowed;
 *  - currencies:[] is FAIL-CLOSED (rejects everything);
 *  - CRUCIAL: the jti is NOT consumed on a currency_not_allowed rejection — no
 *    GameSession is written, and a subsequent valid-currency launch still works.
 *
 * Mirrors test/launch-token.test.ts: real PrismaService, services constructed
 * directly. `freshOperator` is generalised to take currencies/betLimits.
 */

const prisma = new PrismaService();
// Default secret lets GameSessionService sign the session ("play") token;
// LaunchTokenService passes the per-operator secret explicitly, overriding this.
const jwt = new JwtService({ secret: "test-secret" });
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma));

const createdOperatorIds: string[] = [];

async function freshOperator(opts: { currencies?: string[]; betLimits?: unknown } = {}) {
  const op = await prisma.operator.create({
    data: {
      code: "op-ccy-" + randomUUID().slice(0, 8),
      name: "Currency Allowlist Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: opts.currencies ?? ["EUR"],
      ...(opts.betLimits !== undefined ? { betLimits: opts.betLimits as object } : {}),
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe: delete journal users created by any successful launch (username
  // tagged `op:<operatorId>:…` cascades wallets/ledger/profile), then the
  // operators (which cascade their GameSessions). GameSession.walletId has no FK.
  for (const operatorId of createdOperatorIds) {
    await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
  }
  if (createdOperatorIds.length) {
    await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  }
  await prisma.$disconnect();
});

describe("currency allowlist: verify() accepts allowed, rejects disallowed", () => {
  test("a token for an ALLOWED currency verifies OK", async () => {
    const op = await freshOperator({ currencies: ["EUR"] });
    const token = await launch.issue({ operatorId: op.id, playerId: "p-eur", currency: "EUR", locale: "en" });
    const v = await launch.verify(token);
    expect(v.currency).toBe("EUR");
    expect(v.operatorId).toBe(op.id);
    expect(v.jti).toBeTruthy();
  });

  test("a token for a DISALLOWED currency throws currency_not_allowed", async () => {
    const op = await freshOperator({ currencies: ["EUR"] });
    // issue() doesn't enforce the allowlist — it only checks the operator is
    // enabled — so a USD token mints fine and is rejected at verify().
    const token = await launch.issue({ operatorId: op.id, playerId: "p-usd", currency: "USD", locale: "en" });
    await expect(launch.verify(token)).rejects.toThrow("currency_not_allowed");
  });

  test("multi-currency operator: each listed currency is accepted, an unlisted one is rejected", async () => {
    const op = await freshOperator({ currencies: ["EUR", "USDT"] });
    for (const ccy of ["EUR", "USDT"]) {
      const tok = await launch.issue({ operatorId: op.id, playerId: "p-" + ccy, currency: ccy });
      const v = await launch.verify(tok);
      expect(v.currency).toBe(ccy);
    }
    const bad = await launch.issue({ operatorId: op.id, playerId: "p-gbp", currency: "GBP" });
    await expect(launch.verify(bad)).rejects.toThrow("currency_not_allowed");
  });

  test("the allowlist is case-INSENSITIVE (eur matches EUR); the session currency is canonical UPPERCASE", async () => {
    // Phase 3: currency is normalised to ISO-4217 uppercase. A lowercase "eur" is
    // ACCEPTED for an operator that allows "EUR" (no silent casing 401), and the
    // resulting session/wallet currency is canonical "EUR" (no casing fragmentation).
    const op = await freshOperator({ currencies: ["EUR"] });
    const tok = await launch.issue({ operatorId: op.id, playerId: "p-lc", currency: "eur" });
    const session = await sessions.openFromToken(tok);
    expect(session.currency).toBe("EUR");
  });

  test("currencies:[] is FAIL-CLOSED — every currency is rejected", async () => {
    const op = await freshOperator({ currencies: [] });
    for (const ccy of ["EUR", "USD", "DEMO"]) {
      const tok = await launch.issue({ operatorId: op.id, playerId: "p-" + ccy, currency: ccy });
      await expect(launch.verify(tok)).rejects.toThrow("currency_not_allowed");
    }
  });
});

describe("currency allowlist: the jti is NOT consumed on a currency_not_allowed rejection", () => {
  test("no GameSession row is written for the rejected jti, and a fresh valid launch still works", async () => {
    // Operator allows only EUR.
    const op = await freshOperator({ currencies: ["EUR"] });

    // A USD token is rejected at verify() with currency_not_allowed.
    const badToken = await launch.issue({ operatorId: op.id, playerId: "p-mix", currency: "USD", locale: "en" });
    const badClaims = jwt.decode(badToken) as Record<string, any>;
    const badJti = badClaims.jti as string;
    expect(badJti).toBeTruthy();

    await expect(launch.verify(badToken)).rejects.toThrow("currency_not_allowed");

    // CRUCIAL: no GameSession consumed that jti (one-time use was NOT spent).
    const consumed = await prisma.gameSession.findUnique({ where: { launchJti: badJti } });
    expect(consumed).toBeNull();

    // A subsequent VALID-currency launch (fresh token) still opens a session —
    // the rejected attempt didn't poison the operator/player.
    const goodToken = await launch.issue({ operatorId: op.id, playerId: "p-mix", currency: "EUR", locale: "en" });
    const session = await sessions.openFromToken(goodToken);
    expect(session.currency).toBe("EUR");
    expect(session.walletId).toBeTruthy();

    // The good launch's jti IS now consumed (control: the path that should
    // consume does consume).
    const goodJti = (jwt.decode(goodToken) as Record<string, any>).jti as string;
    const goodSession = await prisma.gameSession.findUnique({ where: { launchJti: goodJti } });
    expect(goodSession).not.toBeNull();
    expect(goodSession!.id).toBe(session.sessionId);
  });

  test("openFromToken (the real consume path) also rejects a disallowed currency without writing a session", async () => {
    // Drive the full open path (verify → would create user+session) to prove the
    // rejection short-circuits BEFORE any wallet/user/session row is written.
    const op = await freshOperator({ currencies: ["EUR"] });
    const tok = await launch.issue({ operatorId: op.id, playerId: "p-open-usd", currency: "USD", locale: "en" });
    const jti = (jwt.decode(tok) as Record<string, any>).jti as string;

    await expect(sessions.openFromToken(tok)).rejects.toThrow("currency_not_allowed");

    // No session for that jti …
    expect(await prisma.gameSession.findUnique({ where: { launchJti: jti } })).toBeNull();
    // … and no journal user/wallet was created for this operator player+currency.
    const tag = `op:${op.id}:p-open-usd:USD`;
    expect(await prisma.user.findUnique({ where: { username: tag } })).toBeNull();
  });

  test("currency_not_allowed precedes one-time-use: re-presenting the rejected token still says currency_not_allowed (never already_used)", async () => {
    // Because the jti was never consumed, the SAME disallowed token fails with
    // currency_not_allowed both times — not launch_token_already_used. This pins
    // the ordering: the allowlist check runs before the jti-consumed lookup.
    const op = await freshOperator({ currencies: ["EUR"] });
    const tok = await launch.issue({ operatorId: op.id, playerId: "p-twice", currency: "USD" });
    await expect(launch.verify(tok)).rejects.toThrow("currency_not_allowed");
    await expect(launch.verify(tok)).rejects.toThrow("currency_not_allowed");
  });
});
