import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { makeAudit } from "./helpers/audit";

/**
 * Regression for F-012: a CONCURRENT launch-token replay must fail with a clean 401
 * (UnauthorizedException "launch_token_already_used"), NOT an uncaught Prisma P2002 →
 * HTTP 500 + Sentry noise.
 *
 * The one-time-use invariant is enforced by the `launchJti` UNIQUE constraint and ALWAYS
 * held — under a concurrent double-submit both calls pass verify() (jti still unused), the
 * first gameSession.create wins, the second loses the unique race. THE FIX maps that loser's
 * P2002 to the same clean 401 the sequential-replay path (verify()) already returns, so it
 * can never surface as a 500. Exactly one session is created either way.
 *
 * Drives GameSessionService directly (the openFromToken path the operator launch controller
 * calls), mirroring operator-session-c2.test.ts.
 */

const JWT_SECRET = "f012-replay-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));

const createdOperatorIds: string[] = [];

async function freshOperator(currency = "EUR") {
  const op = await prisma.operator.create({
    data: {
      code: "op-f012-" + randomUUID().slice(0, 8),
      name: "F012 Replay Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  for (const operatorId of createdOperatorIds) {
    // F-017: user→wallet is RESTRICT — delete child rows first, then the users.
    const opUser = { user: { username: { startsWith: `op:${operatorId}:` } } } as const;
    await prisma.bet.deleteMany({ where: { wallet: opUser } });
    await prisma.ledgerTransaction.deleteMany({ where: { wallet: opUser } });
    await prisma.profile.deleteMany({ where: opUser });
    await prisma.wallet.deleteMany({ where: opUser });
    await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
  }
  if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  await prisma.$disconnect();
});

test("F-012 concurrent replay: exactly one session created, the loser gets a clean 401 (not a 500)", async () => {
  const op = await freshOperator("EUR");
  const playerId = "player-" + randomUUID().slice(0, 8);
  const token = await launch.issue({ operatorId: op.id, playerId, currency: "EUR", locale: "en" });

  // Fire the SAME valid token at openFromToken twice in parallel — both pass verify()'s
  // jti-unused precheck; only one gameSession.create can win the unique launchJti race.
  const results = await Promise.allSettled([
    sessions.openFromToken(token),
    sessions.openFromToken(token),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

  // Exactly one launch succeeded.
  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(1);

  // The loser failed with a clean 401 — NOT an uncaught Prisma P2002 (which would 500).
  const err = rejected[0].reason;
  expect(err).toBeInstanceOf(UnauthorizedException);
  expect((err as UnauthorizedException).getStatus()).toBe(401);
  // Same message the sequential-replay path (verify()) returns, so the error shape is uniform.
  const body: any = (err as UnauthorizedException).getResponse();
  expect(typeof body === "string" ? body : body.message).toBe("launch_token_already_used");
  // It must NOT be a raw Prisma error leaking through.
  expect((err as Error).constructor.name).not.toBe("PrismaClientKnownRequestError");

  // Exactly ONE GameSession exists for this jti (the unique invariant held).
  const jti = (jwt.decode(token) as any).jti as string;
  expect(await prisma.gameSession.count({ where: { launchJti: jti } })).toBe(1);
});

test("F-012 sequential replay: a second open of a consumed token is also a clean 401", async () => {
  const op = await freshOperator("EUR");
  const playerId = "player-" + randomUUID().slice(0, 8);
  const token = await launch.issue({ operatorId: op.id, playerId, currency: "EUR", locale: "en" });

  // First open succeeds and consumes the jti.
  await sessions.openFromToken(token);

  // A later replay is rejected by verify()'s jti-used check — same 401, no 500.
  let err: unknown;
  try {
    await sessions.openFromToken(token);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(UnauthorizedException);
  expect((err as UnauthorizedException).getStatus()).toBe(401);
  const body: any = (err as UnauthorizedException).getResponse();
  expect(typeof body === "string" ? body : body.message).toBe("launch_token_already_used");
});
