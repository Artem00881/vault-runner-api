import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { SeamlessOperatorWallet } from "../src/wallet/seamless-operator-wallet";
import { WalletRouter } from "../src/wallet/wallet-router";
import { MockOperator } from "./helpers/mock-operator";

/**
 * Phase 3 — demo / fun mode, the WalletRouter (THE money-safety boundary).
 *
 * Adversarial: in operator (real-money) mode the router must settle a DEMO wallet
 * on the internal ledger and NEVER call the operator's real wallet — on any path —
 * while a REAL wallet still routes to the operator. Routing is purely by walletId,
 * and it FAILS SAFE to play money whenever a wallet's mode is unknown.
 *
 *   1. demo debit + credit move the LEDGER and the operator is never touched;
 *   2. a real wallet's debit DOES hit the operator (and the local journal stays 0);
 *   3. rollback: demo = ledger no-op (no operator.rollback); real = operator.rollback;
 *   4. getBalance routes per wallet (demo → ledger, real → operator);
 *   5. FAIL-SAFE: a wallet with no session, and an isDemoWallet that THROWS, both
 *      resolve to the ledger — an unsure money move never reaches the operator.
 */

const jwt = new JwtService({ secret: "demo-routing-secret" });
const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, ledger);

const createdOperatorIds: string[] = [];
const createdUserIds: string[] = [];

async function freshOperator(currency = "EUR") {
  const op = await prisma.operator.create({
    data: {
      code: "op-demo-rt-" + randomUUID().slice(0, 8),
      name: "Demo Routing Operator",
      enabled: true,
      demoEnabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
    },
  });
  createdOperatorIds.push(op.id);
  return op;
}

async function open(playerId: string, currency: string, demo: boolean) {
  const op = await freshOperator(currency);
  const token = await launch.issue({ operatorId: op.id, playerId, currency, demo });
  return sessions.openFromToken(token);
}

/** Fresh operator wallet + router for clean per-test call counters. */
function freshRouter(seed: Record<string, number> = {}) {
  const mockOperator = new MockOperator(seed);
  const seamless = new SeamlessOperatorWallet(mockOperator, sessions.resolver());
  const router = new WalletRouter(ledger, seamless, (w) => sessions.isDemoWallet(w));
  return { mockOperator, router };
}

function noOperatorCalls(m: MockOperator) {
  expect(m.calls).toEqual({ bet: 0, win: 0, rollback: 0, balance: 0 });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  for (const operatorId of createdOperatorIds) {
    await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
  }
  if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  if (createdOperatorIds.length) {
    await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  }
  await prisma.$disconnect();
});

test("1. a demo wallet's debit+credit move the LEDGER and NEVER touch the operator", async () => {
  const demo = await open("rt-demo-1", "EUR", true); // seeded to 10000 on the ledger
  const { mockOperator, router } = freshRouter();

  const afterDebit = await router.debit(demo.walletId, 1000n, "bet_debit", `bet:${randomUUID()}:debit`);
  expect(afterDebit.balanceAfter).toBe(9000n);
  const afterCredit = await router.credit(demo.walletId, 500n, "payout_credit", `bet:${randomUUID()}:payout`);
  expect(afterCredit.balanceAfter).toBe(9500n);

  expect(await ledger.getBalance(demo.walletId)).toBe(9500n);
  noOperatorCalls(mockOperator); // the headline assertion: play money never hit the operator
});

test("2. a REAL wallet's debit hits the operator; the local journal stays 0", async () => {
  const playerId = "rt-real-2";
  const currency = "EUR";
  const real = await open(playerId, currency, false);
  const { mockOperator, router } = freshRouter({ [`${playerId}:${currency}`]: 1000 });

  const r = await router.debit(real.walletId, 100n, "bet_debit", `bet:${randomUUID()}:debit`);
  expect(r.balanceAfter).toBe(900n); // operator is the source of truth
  expect(mockOperator.calls.bet).toBe(1);
  expect(mockOperator.balanceOf(playerId, currency)).toBe(900n);

  const localJournal = await prisma.wallet.findUniqueOrThrow({ where: { id: real.walletId } });
  expect(localJournal.balance).toBe(0n); // never debited locally for a real wallet
});

test("3. rollback routes per wallet: demo = ledger no-op, real = operator.rollback", async () => {
  const demo = await open("rt-demo-3", "EUR", true);
  const real = await open("rt-real-3", "EUR", false);
  const { mockOperator, router } = freshRouter({ "rt-real-3:EUR": 1000 });

  await router.rollback(demo.walletId, `bet:${randomUUID()}:debit`);
  expect(mockOperator.calls.rollback).toBe(0); // demo never reaches the operator

  await router.rollback(real.walletId, `bet:${randomUUID()}:debit`);
  expect(mockOperator.calls.rollback).toBe(1);
});

test("4. getBalance routes per wallet (demo → ledger, real → operator)", async () => {
  const demo = await open("rt-demo-4", "EUR", true);
  const playerId = "rt-real-4";
  const real = await open(playerId, "EUR", false);
  const { mockOperator, router } = freshRouter({ [`${playerId}:EUR`]: 777 });

  expect(await router.getBalance(demo.walletId)).toBe(10000n); // ledger
  expect(mockOperator.calls.balance).toBe(0);

  expect(await router.getBalance(real.walletId)).toBe(777n); // operator
  expect(mockOperator.calls.balance).toBe(1);
});

test("5a. FAIL-SAFE: a wallet with NO session routes to the ledger, not the operator", async () => {
  // A ledger wallet that never went through an operator launch (e.g. a guest) has
  // no GameSession → isDemoWallet is indeterminate → must resolve to play money.
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "rt_nosession_" + id.slice(0, 8),
      wallets: { create: { currency: "EUR", balance: 5000n } },
      profile: { create: { displayName: "ns" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  const walletId = u.wallets[0].id;

  expect(await sessions.isDemoWallet(walletId)).toBe(true); // no session → fail safe
  const { mockOperator, router } = freshRouter();
  const r = await router.debit(walletId, 1000n, "bet_debit", `x:${randomUUID()}`);
  expect(r.balanceAfter).toBe(4000n); // ledger
  noOperatorCalls(mockOperator);
});

test("5b. FAIL-CLOSED: isDemoWallet PROPAGATES a lookup error (does not fail-open to the ledger)", async () => {
  // A genuine lookup error must NOT be swallowed: on a real payout the money move has
  // to fail closed into the recovery machinery (→ payout_pending → reconciler), not
  // silently credit the play-money ledger and lose the real obligation (money-path
  // HIGH). Routing still never reaches the operator on an unsure call — the op throws.
  const brokenPrisma: any = {
    gameSession: {
      findFirst: async () => {
        throw new Error("db down");
      },
    },
  };
  const broken = new GameSessionService(brokenPrisma, launch, jwt, ledger);
  await expect(broken.isDemoWallet("any-wallet-id")).rejects.toThrow(/db down/);
});

test("5c. FAIL-CLOSED: a REAL operator wallet whose session vanished is NOT classified demo", async () => {
  const real = await open("rt-lost-session", "EUR", false);
  expect(await sessions.isDemoWallet(real.walletId)).toBe(false); // has a real session

  // Simulate an operator hard-delete cascade: the session row is gone, but the wallet
  // (op:… tag, no :demo) still owes real money. It must stay NON-demo so a payout fails
  // closed on the operator path instead of being silently credited to the play ledger.
  await prisma.gameSession.deleteMany({ where: { walletId: real.walletId } });
  expect(await sessions.isDemoWallet(real.walletId)).toBe(false);
});

test("6. isDemoWallet reflects the persisted session mode", async () => {
  const demo = await open("rt-flag-demo", "EUR", true);
  const real = await open("rt-flag-real", "EUR", false);
  expect(await sessions.isDemoWallet(demo.walletId)).toBe(true);
  expect(await sessions.isDemoWallet(real.walletId)).toBe(false);
});
