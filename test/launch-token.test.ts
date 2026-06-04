import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LedgerService } from "../src/wallet/ledger.service";

const prisma = new PrismaService();
// A default secret so GameSessionService can sign the session ("play") token;
// LaunchTokenService passes the per-operator secret explicitly, overriding this.
const jwt = new JwtService({ secret: "test-secret" });
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma));

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
afterAll(async () => { await prisma.$disconnect(); });

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
