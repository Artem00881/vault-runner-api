import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LedgerService } from "../src/wallet/ledger.service";

/**
 * Phase 3.6 — launch response decimals + locale normalization (DB-backed). Mirrors the
 * launch-token / RG-enforcement harness (real Prisma; LaunchTokenService.issue signs a
 * per-operator token; GameSessionService.openFromToken consumes it). Proves the wire
 * contract the embedding client renders from on first paint:
 *  - the launch response carries `decimals` = currencyMeta(currency).decimals
 *    (USDT→6, EUR→2, JPY→0 — non-2 canaries prove it's real, not constant);
 *  - the locale is normalized end-to-end (token claim → launch response → GameSession.locale):
 *    "EN-us" → "en-US"; garbage locale → "en" (and the DB row is never corrupted with it);
 *  - an UNKNOWN currency (the operator allow-lists it) still launches: response decimals
 *    fall back to 2 (known:false) and the path stays UP (no throw, jti consumed once).
 */

const prisma = new PrismaService();
const jwt = new JwtService({ secret: "locale-decimals-secret" });
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma));

const createdOperatorIds: string[] = [];

async function freshOperator(currencies: string[]) {
  const op = await prisma.operator.create({
    data: {
      code: "op-ld-" + randomUUID().slice(0, 8),
      name: "Locale/Decimals Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: currencies.map((c) => c.toUpperCase()),
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  try {
    // Sessions + journal users are created by openFromToken; sweep journal users by the
    // op:<id>: tag, then the operator (sessions cascade with the operator). FK-safe.
    for (const operatorId of createdOperatorIds) {
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("LD.1 launch response carries currency decimals", () => {
  test.each([
    ["USDT", 6],
    ["EUR", 2],
    ["JPY", 0],
    ["BTC", 8],
  ])("a %s launch → response.decimals = %d", async (currency, decimals) => {
    const op = await freshOperator([currency]);
    const token = await launch.issue({ operatorId: op.id, playerId: "p-" + randomUUID().slice(0, 6), currency });
    const s = await sessions.openFromToken(token);
    expect(s.currency).toBe(currency);
    expect(s.decimals).toBe(decimals);
  });

  test("decimals tracks the CANONICAL upper currency even if the token sent lowercase", async () => {
    const op = await freshOperator(["USDT"]);
    const token = await launch.issue({ operatorId: op.id, playerId: "p-lc", currency: "usdt" });
    const s = await sessions.openFromToken(token);
    expect(s.currency).toBe("USDT"); // canonicalised
    expect(s.decimals).toBe(6); // real precision, not the 2-dp fallback
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("LD.2 locale normalized end-to-end (token → response → GameSession row)", () => {
  test('"EN-us" → "en-US" on both the launch response and the persisted session', async () => {
    const op = await freshOperator(["EUR"]);
    const token = await launch.issue({ operatorId: op.id, playerId: "p-loc", currency: "EUR", locale: "EN-us" });
    const s = await sessions.openFromToken(token);
    expect(s.locale).toBe("en-US"); // normalized on the response
    const row = await prisma.gameSession.findUniqueOrThrow({ where: { id: s.sessionId } });
    expect(row.locale).toBe("en-US"); // and persisted normalized
  });

  test('"pt-br" → "pt-BR" round-trips to the row', async () => {
    const op = await freshOperator(["EUR"]);
    const token = await launch.issue({ operatorId: op.id, playerId: "p-ptbr", currency: "EUR", locale: "pt-br" });
    const s = await sessions.openFromToken(token);
    expect(s.locale).toBe("pt-BR");
    const row = await prisma.gameSession.findUniqueOrThrow({ where: { id: s.sessionId } });
    expect(row.locale).toBe("pt-BR");
  });

  test("a garbage locale → \"en\"; the DB row is NEVER corrupted with the raw value", async () => {
    const op = await freshOperator(["EUR"]);
    const poison = "'; DROP TABLE game_sessions; --";
    const token = await launch.issue({ operatorId: op.id, playerId: "p-bad", currency: "EUR", locale: poison });
    const s = await sessions.openFromToken(token);
    expect(s.locale).toBe("en"); // defaulted
    const row = await prisma.gameSession.findUniqueOrThrow({ where: { id: s.sessionId } });
    expect(row.locale).toBe("en");
    expect(row.locale).not.toContain("DROP"); // raw garbage never reached the column
  });

  test("an absent locale defaults to \"en\"", async () => {
    const op = await freshOperator(["EUR"]);
    const token = await launch.issue({ operatorId: op.id, playerId: "p-nolocale", currency: "EUR" }); // no locale
    const s = await sessions.openFromToken(token);
    expect(s.locale).toBe("en");
    const row = await prisma.gameSession.findUniqueOrThrow({ where: { id: s.sessionId } });
    expect(row.locale).toBe("en");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("LD.3 an unknown (allow-listed) currency still launches with a 2-dp fallback", () => {
  test("launch succeeds, response.decimals = 2, session row written, jti consumed once", async () => {
    // The operator allow-lists a currency with NO canonical precision entry (a brand-new
    // token onboarded before it's seeded). The launch must NOT break — currencyMeta falls
    // back to 2 dp (known:false) so the path stays up.
    const op = await freshOperator(["XYZ"]);
    const token = await launch.issue({ operatorId: op.id, playerId: "p-xyz", currency: "XYZ" });
    const s = await sessions.openFromToken(token);
    expect(s.currency).toBe("XYZ");
    expect(s.decimals).toBe(2); // unknown → fallback, but the launch still worked
    const row = await prisma.gameSession.findUniqueOrThrow({ where: { id: s.sessionId } });
    expect(row.currency).toBe("XYZ");
    // one-time use still holds for an unknown currency.
    await expect(sessions.openFromToken(token)).rejects.toThrow("launch_token_already_used");
  });
});
