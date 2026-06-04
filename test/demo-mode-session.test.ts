import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LedgerService } from "../src/wallet/ledger.service";

/**
 * Phase 3 — demo / fun mode, session layer.
 *
 * Proves, against the diff:
 *   1. a demo launch persists GameSession.demo=true and the play token carries demo:true;
 *   2. SEEDING — the demo wallet is funded to the full play-money bankroll via one
 *      `adjustment` ledger row keyed `demo:reset:{sessionId}` (the internal ledger,
 *      NOT the operator);
 *   3. RESET-ON-RELAUNCH (the operator's chosen semantics) — spend the demo wallet
 *      down, relaunch the same player, and the balance is back to FULL (a fresh
 *      top-up adjustment), not the spent-down carry-over;
 *   4. ISOLATION — the same {operator, player, currency} launched real vs demo
 *      resolves to DIFFERENT wallets/users (a `:demo` user tag), so play money and
 *      real money can never share one journal;
 *   5. a REAL session is unchanged: wallet created at balance 0, no seed row.
 */

// Default play-money bankroll (game-session.service.ts DEMO_STARTING_BALANCE; the
// test env doesn't override it). Integer minor units.
const DEMO_STARTING = 10000n;

const jwt = new JwtService({ secret: "demo-session-secret" });
const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, ledger);

const createdOperatorIds: string[] = [];

async function freshOperator(currency = "EUR") {
  const op = await prisma.operator.create({
    data: {
      code: "op-demo-sess-" + randomUUID().slice(0, 8),
      name: "Demo Session Operator",
      enabled: true,
      demoEnabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

/** Mint + consume a launch token → a live session. */
async function open(opts: { op: { id: string }; playerId: string; currency: string; demo: boolean }) {
  const token = await launch.issue({
    operatorId: opts.op.id,
    playerId: opts.playerId,
    currency: opts.currency,
    demo: opts.demo,
  });
  return sessions.openFromToken(token);
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  for (const operatorId of createdOperatorIds) {
    await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
  }
  if (createdOperatorIds.length) {
    await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  }
  await prisma.$disconnect();
});

test("1. demo launch persists GameSession.demo and signs demo into the play token", async () => {
  const op = await freshOperator();
  const session = await open({ op, playerId: "pd1", currency: "EUR", demo: true });

  const row = await prisma.gameSession.findUniqueOrThrow({ where: { id: session.sessionId } });
  expect(row.demo).toBe(true);

  const payload = await jwt.verifyAsync(session.token!);
  expect(payload.demo).toBe(true);
  expect(payload.kind).toBe("operator");
});

test("2. demo wallet is SEEDED to the full bankroll via one ledger adjustment (not the operator)", async () => {
  const op = await freshOperator();
  const session = await open({ op, playerId: "pd2", currency: "EUR", demo: true });

  // Balance funded to full, straight on the internal ledger.
  expect(await ledger.getBalance(session.walletId)).toBe(DEMO_STARTING);

  // Exactly one seed row, keyed to THIS launch, of the right shape.
  const seed = await prisma.ledgerTransaction.findUniqueOrThrow({
    where: { idempotencyKey: `demo:reset:${session.sessionId}` },
  });
  expect(seed.type).toBe("adjustment");
  expect(seed.amount).toBe(DEMO_STARTING); // 0 → full
  expect(seed.balanceAfter).toBe(DEMO_STARTING);
  expect(seed.refType).toBe("demo_reset");
});

test("3. RESET-on-relaunch: a spent-down demo wallet is topped back to full on the next launch", async () => {
  const op = await freshOperator();
  const first = await open({ op, playerId: "pd3", currency: "EUR", demo: true });
  expect(await ledger.getBalance(first.walletId)).toBe(DEMO_STARTING);

  // Spend it down (simulate play).
  await ledger.debit(first.walletId, 4000n, "bet_debit", `spend:${randomUUID()}`);
  expect(await ledger.getBalance(first.walletId)).toBe(DEMO_STARTING - 4000n);

  // Relaunch the SAME player+currency (fresh token/jti) → same demo wallet, reset to full.
  const second = await open({ op, playerId: "pd3", currency: "EUR", demo: true });
  expect(second.walletId).toBe(first.walletId); // same demo journal across launches
  expect(await ledger.getBalance(second.walletId)).toBe(DEMO_STARTING); // RESET, not carried over (6000)

  // Two distinct top-up rows: +10000 (initial), then +4000 (reset to full).
  const resets = await prisma.ledgerTransaction.findMany({
    where: { walletId: first.walletId, refType: "demo_reset" },
    orderBy: { createdAt: "asc" },
  });
  expect(resets.length).toBe(2);
  expect(resets[1].amount).toBe(4000n);
});

test("4. ISOLATION: same operator+player+currency, real vs demo → different wallets/users", async () => {
  const op = await freshOperator();
  const real = await open({ op, playerId: "shared", currency: "EUR", demo: false });
  const demo = await open({ op, playerId: "shared", currency: "EUR", demo: true });

  expect(demo.walletId).not.toBe(real.walletId); // distinct journals

  const realW = await prisma.wallet.findUniqueOrThrow({ where: { id: real.walletId }, include: { user: true } });
  const demoW = await prisma.wallet.findUniqueOrThrow({ where: { id: demo.walletId }, include: { user: true } });
  expect(demoW.userId).not.toBe(realW.userId);
  expect(demoW.user.username.endsWith(":demo")).toBe(true);
  expect(realW.user.username.endsWith(":demo")).toBe(false);
});

test("5. REAL session is unchanged: wallet starts at 0, no seed row", async () => {
  const op = await freshOperator();
  const real = await open({ op, playerId: "pr5", currency: "EUR", demo: false });

  expect(await ledger.getBalance(real.walletId)).toBe(0n); // journal anchor only
  const resets = await prisma.ledgerTransaction.count({
    where: { walletId: real.walletId, refType: "demo_reset" },
  });
  expect(resets).toBe(0);

  const payload = await jwt.verifyAsync(real.token!);
  expect(payload.demo).toBeUndefined(); // omitted from the token when not demo
});
