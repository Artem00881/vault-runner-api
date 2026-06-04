import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";

/**
 * Regression for audit M-C2.1 — resolve a bet's wallet by the SESSION's bound
 * `walletId`, not by `findFirst`-over-`userId`.
 *
 * `src/game/bets.service.ts` (private `wallet(userId, walletId?)` +
 * `placeBet(..., walletId?)`), `src/operator/game-session.service.ts`
 * (`openFromToken` now mints a play token carrying a `walletId` claim).
 *
 * The schema permits a user to hold MORE THAN ONE wallet
 * (`Wallet @@unique([userId, currency])` — one per currency, not one per user).
 * PRE-FIX `placeBet` ignored any session wallet and called
 * `findFirstOrThrow({ where: { userId } })`, which (no `orderBy`) returns an
 * ARBITRARY wallet (in practice the first-inserted). So a multi-wallet player's
 * bet could land on / debit the wrong currency, and a stale/forged session
 * `walletId` had no userId-ownership guard.
 *
 * THE FIX / INVARIANT:
 *  - With a session `walletId`: the bet is placed on EXACTLY that wallet
 *    (`findUniqueOrThrow({ id: walletId })`) AND only if it belongs to the
 *    caller (`w.userId === userId`, the money trust anchor) — else a clean
 *    `{ ok:false, reason:"bet_failed" }` (no throw, no cross-user debit).
 *  - Without one (a guest, single wallet): unchanged `findFirst` fallback.
 *  - The operator launch token carries `walletId` so the gateway can pass it.
 *
 * Cases 1–3 drive the REAL `placeBet` path (internal ledger as WalletProvider,
 * real Risk/Metrics, a fake engine pinned to "betting"). Case 4 unit-tests the
 * token claim. Empirically (verified before writing): with the EUR wallet
 * created SECOND, `findFirstOrThrow({userId})` returns the DEMO wallet — so
 * targeting EUR via `walletId` and asserting `bet.walletId === eurWallet.id`
 * is genuinely fails-first against pre-M-C2.1 code.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();

// Fake engine: pins a deterministic round in the betting window. BetsService
// only reads getPublicState() in placeBet, so this is all it needs.
let activeRoundId = "";
const fakeEngine: any = {
  getPublicState: () => ({
    roundId: activeRoundId,
    phase: "betting",
    phaseEndsAt: Date.now() + 5000,
    multiplier: 1.0,
    serverTime: Date.now(),
  }),
  currentMultiplier: () => 1.0,
};

const bets = new BetsService(prisma, ledger, fakeEngine, risk, metrics);

// For case 4 (operator session token). Mirrors operator-session-c2.test.ts /
// launch-token.test.ts: GameSessionService signs the play token with this
// JwtService; LaunchTokenService passes the per-operator launchSecret explicitly.
const SESSION_SECRET = "mc21-session-secret";
const jwt = new JwtService({ secret: SESSION_SECRET });
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma));

// Track synthetic rows for FK-safe cleanup (bets → rounds → seeds → chains;
// users cascade wallets/ledger/profile; operators cascade their sessions).
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];
const createdOperatorIds: string[] = [];

async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 3_000_000 + Math.floor(Math.random() * 1_000_000), // synthetic epoch (>= 3_000_000)
      commitHash: "mc21commit-" + randomUUID(),
      length: 2,
      salt: "mc21salt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "mc21h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "betting", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** A user with a SINGLE DEMO wallet (the guest-style shape). */
async function freshUser(balance: bigint): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "mc21_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "mc21" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

/**
 * A user with TWO funded wallets. The EUR wallet is created SECOND on purpose,
 * so `findFirstOrThrow({ where: { userId } })` (no orderBy) returns the DEMO
 * wallet — making "target EUR via walletId" a real fails-first probe.
 */
async function freshTwoWalletUser(demoBalance: bigint, eurBalance: bigint) {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "mc21_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance: demoBalance } }, // FIRST → what findFirst returns
      profile: { create: { displayName: "mc21" } },
    },
    include: { wallets: true },
  });
  const eur = await prisma.wallet.create({ data: { userId: id, currency: "EUR", balance: eurBalance } }); // SECOND
  createdUserIds.push(id);
  return { userId: id, demoWalletId: u.wallets[0].id, eurWalletId: eur.id };
}

async function freshOperator(currency: string) {
  const op = await prisma.operator.create({
    data: {
      code: "op-mc21-" + randomUUID().slice(0, 8),
      name: "MC21 Test Operator",
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
});

afterAll(async () => {
  try {
    // FK-safe order: bets → rounds → seeds → chains; users cascade their
    // wallets/ledger/profile/bets; operators cascade their GameSessions.
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    // Operator-launched journal users are tagged op:<operatorId>:… — remove them
    // before their operators (GameSession.walletId has no FK, so order is safe).
    for (const operatorId of createdOperatorIds) {
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

test("1. CORE: placeBet resolves the EXACT session walletId (EUR), not findFirst (DEMO)", async () => {
  // One user, TWO funded wallets; EUR created second so findFirst would pick DEMO.
  activeRoundId = await freshRound();
  const { userId, demoWalletId, eurWalletId } = await freshTwoWalletUser(10_000n, 10_000n);
  const amount = 100;

  // Sanity that the precondition holds for THIS row: findFirst returns DEMO, not EUR.
  const ff = await prisma.wallet.findFirstOrThrow({ where: { userId } });
  expect(ff.id).toBe(demoWalletId);
  expect(ff.id).not.toBe(eurWalletId);

  // Place the bet TARGETING the EUR wallet via the trailing walletId arg.
  const r = await bets.placeBet(userId, "A", amount, undefined, eurWalletId);
  expect(r.ok).toBe(true);
  expect(r.currency).toBe("EUR"); // result reflects the EUR wallet's currency

  // THE INVARIANT: the bet landed on EXACTLY the EUR wallet. Pre-M-C2.1 (findFirst)
  // this would be the DEMO wallet → this assertion FAILS = genuine fails-first.
  const betRow = await prisma.bet.findUniqueOrThrow({
    where: { roundId_userId_panel: { roundId: activeRoundId, userId, panel: "A" } },
  });
  expect(betRow.walletId).toBe(eurWalletId);

  // And the MONEY moved on EUR only: EUR dropped by the stake, DEMO untouched.
  expect(await ledger.getBalance(eurWalletId)).toBe(10_000n - BigInt(amount));
  expect(await ledger.getBalance(demoWalletId)).toBe(10_000n);

  // Belt-and-braces at the ledger level: the single bet_debit is on the EUR wallet.
  const eurDebits = await prisma.ledgerTransaction.findMany({ where: { walletId: eurWalletId, type: "bet_debit" } });
  expect(eurDebits.length).toBe(1);
  expect(eurDebits[0].amount).toBe(-BigInt(amount));
  const demoDebits = await prisma.ledgerTransaction.findMany({ where: { walletId: demoWalletId, type: "bet_debit" } });
  expect(demoDebits.length).toBe(0);
});

test("2. CROSS-USER GUARD: placeBet with another user's walletId is cleanly rejected, no debit", async () => {
  // User A and user B each own one wallet. A tries to bet on B's wallet.
  activeRoundId = await freshRound();
  const a = await freshUser(10_000n);
  const b = await freshUser(10_000n);
  const amount = 100;

  const r = await bets.placeBet(a.userId, "A", amount, undefined, b.walletId);

  // Clean reject (NOT a throw, NOT a silent success). The userId-ownership check
  // in wallet() throws internally → placeBet maps it to reason "bet_failed".
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("bet_failed");

  // No bet row was created for A on B's wallet (or anywhere for A this round).
  const aBets = await prisma.bet.findMany({ where: { roundId: activeRoundId, userId: a.userId } });
  expect(aBets.length).toBe(0);
  const bWalletBets = await prisma.bet.findMany({ where: { roundId: activeRoundId, walletId: b.walletId } });
  expect(bWalletBets.length).toBe(0);

  // THE INVARIANT: B's wallet was NOT debited (no cross-user money movement).
  // Pre-fix (no ownership check) A's bet would resolve+debit B's wallet → FAILS.
  expect(await ledger.getBalance(b.walletId)).toBe(10_000n);
  const bDebits = await prisma.ledgerTransaction.findMany({ where: { walletId: b.walletId, type: "bet_debit" } });
  expect(bDebits.length).toBe(0);
  // And A was not charged on its own wallet either.
  expect(await ledger.getBalance(a.walletId)).toBe(10_000n);
});

test("3. GUEST FALLBACK: single-wallet user, no walletId → succeeds on that wallet (unchanged)", async () => {
  // No session walletId is passed (guest path). findFirst resolves the sole wallet.
  activeRoundId = await freshRound();
  const { userId, walletId } = await freshUser(10_000n);
  const amount = 100;

  const r = await bets.placeBet(userId, "A", amount); // no walletId arg
  expect(r.ok).toBe(true);
  expect(r.currency).toBe("DEMO");

  const betRow = await prisma.bet.findUniqueOrThrow({
    where: { roundId_userId_panel: { roundId: activeRoundId, userId, panel: "A" } },
  });
  expect(betRow.walletId).toBe(walletId);
  expect(await ledger.getBalance(walletId)).toBe(10_000n - BigInt(amount));
});

test("4. SESSION TOKEN carries walletId == bound wallet, sub == that wallet's userId", async () => {
  const currency = "EUR";
  const op = await freshOperator(currency);
  const playerId = "player-" + randomUUID().slice(0, 8);

  const launchToken = await launch.issue({ operatorId: op.id, playerId, currency, locale: "en" });
  const session = await sessions.openFromToken(launchToken);

  expect(session.token).toBeTruthy();
  // Decode the play token the way the gateway does (verify with OUR secret).
  const payload = await jwt.verifyAsync(session.token!);

  // M-C2.1: the play token carries the session's bound wallet id, and `sub` is
  // that wallet's userId (the money trust anchor). The gateway stores
  // client.data.walletId = payload.walletId and passes it to placeBet.
  expect(payload.walletId).toBe(session.walletId);

  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: session.walletId } });
  expect(payload.sub).toBe(wallet.userId);
  expect(payload.currency).toBe(currency);

  // The very claim the gateway forwards resolves (under M-C2.1) back to this exact
  // wallet for this user — i.e. placeBet(payload.sub, ..., payload.walletId) would
  // bet on the session's bound wallet.
  expect(wallet.id).toBe(payload.walletId);
  expect(wallet.userId).toBe(payload.sub);
});
