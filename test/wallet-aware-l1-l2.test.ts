import { test, expect, beforeAll, afterAll } from "bun:test";
import { ForbiddenException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { WalletController } from "../src/wallet/wallet.controller";
import { makeAudit } from "./helpers/audit";

/**
 * Regression for audit M-C2.1 follow-ups L-1 + L-2 (operator-aware wallet path).
 *
 * L-1 — operator-aware wallet ENDPOINTS. `src/auth/jwt-auth.guard.ts` now lifts
 * `payload.walletId` onto the request (+ a `CurrentWalletId` decorator), and
 * `src/wallet/wallet.controller.ts` resolves via a private `resolveWallet(userId,
 * walletId?)`: a session `walletId` → `findUniqueOrThrow({ id })` + an ownership
 * guard (`w.userId === userId`, else `ForbiddenException("wallet_mismatch")`);
 * no walletId (a guest) → the old `findFirst({ userId })` fallback. So both
 * GET /api/wallet/balance and /transactions report EXACTLY the session-bound
 * wallet (robust when a user holds >1 wallet) and never another user's.
 *   PRE-L-1 the controller ignored walletId and always `findFirst`'d over userId,
 *   which (no orderBy) returns an arbitrary/first-inserted wallet. We create the
 *   EUR wallet SECOND so findFirst returns DEMO, then ask for EUR by id and assert
 *   EUR — genuinely fails-first against the old code.
 *
 * L-2 — a DISTINCT rejected metric for a cross-user/mismatched session walletId.
 * `src/game/bets.service.ts` added a `WalletOwnershipError` (thrown by the private
 * `wallet(userId, walletId?)` on `w.userId !== userId`); placeBet's resolution
 * `.catch` records `recordRejected("wallet_owner_mismatch")` for it (vs the
 * generic `"bet_failed"` for any other resolution failure, e.g. a non-existent
 * walletId). The CLIENT still sees a generic `bet_failed` (no info leak); only
 * the metric is distinct, so a cross-user probe pattern is alertable.
 *   PRE-L-2 both surfaced as `bet_failed`, so the `wallet_owner_mismatch` series
 *   would never increment — fails-first.
 *
 * Needs docker Postgres+Redis (real Prisma). The controller is a plain class
 * (prisma, wallet$); we hand it the internal LedgerService as the WalletProvider,
 * exactly like other tests build providers. L-2 reuses the placeBet harness from
 * wallet-resolution-mc21.test.ts (BetsService + a fake engine pinned to "betting"
 * + a real MetricsService) and reads the rejected counter off the registry.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();

// L-1: the controller is a plain class — construct it directly with the internal
// ledger as the WalletProvider (it only calls wallet$.getBalance).
const controller = new WalletController(prisma, ledger);

// L-2: fake engine pinned to the betting window (placeBet only reads getPublicState()).
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
const bets = new BetsService(prisma, ledger, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

// Track synthetic rows for FK-safe cleanup. Users cascade their
// wallets/ledger/profile/bets; we still null out the round refs first.
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];

/** Read a specific labelled value off a prom-client counter (absent series == 0). */
async function rejectedCount(reason: string): Promise<number> {
  const m = await metrics.betsRejected.get();
  return m.values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

/** A FK-valid round in the betting window so placeBet can attach a bet. */
async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 3_000_000 + Math.floor(Math.random() * 1_000_000), // synthetic epoch (>= 3_000_000)
      commitHash: "l1l2commit-" + randomUUID(),
      length: 2,
      salt: "l1l2salt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "l1l2h-" + randomUUID() },
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
      username: "l1l2_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "l1l2" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

/**
 * A user with TWO funded wallets. The EUR wallet is created SECOND on purpose so
 * `findFirstOrThrow({ where: { userId } })` (no orderBy) returns the DEMO wallet —
 * making "ask for EUR by walletId" a real fails-first probe against pre-L-1 code.
 */
async function freshTwoWalletUser(demoBalance: bigint, eurBalance: bigint) {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "l1l2_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance: demoBalance } }, // FIRST → what findFirst returns
      profile: { create: { displayName: "l1l2" } },
    },
    include: { wallets: true },
  });
  const eur = await prisma.wallet.create({ data: { userId: id, currency: "EUR", balance: eurBalance } }); // SECOND
  createdUserIds.push(id);
  return { userId: id, demoWalletId: u.wallets[0].id, eurWalletId: eur.id };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  try {
    // FK-safe: bets → rounds → seeds → chains; users cascade wallets/ledger/profile/bets.
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// L-1 — operator-aware wallet endpoints (construct WalletController directly).
// ---------------------------------------------------------------------------

test("L-1 / 1. balance + transactions resolve the EXACT session walletId (EUR), not findFirst (DEMO)", async () => {
  // One user, TWO funded wallets with DIFFERENT balances; EUR created second so
  // findFirst would pick DEMO. We fund EUR with a DISTINCT amount so a wrong
  // resolution can't accidentally match.
  const demoBalance = 10_000n;
  const eurBalance = 777n;
  const { userId, demoWalletId, eurWalletId } = await freshTwoWalletUser(demoBalance, eurBalance);

  // Give EUR a ledger row so /transactions has something EUR-specific to return.
  await ledger.credit(eurWalletId, 50n, "deposit", "l1-eur-dep-" + randomUUID(), {
    refType: "test",
    refId: randomUUID(),
  });
  const eurBalAfter = eurBalance + 50n;

  // Precondition for THIS row: findFirst returns DEMO, not EUR (so the probe is fails-first).
  const ff = await prisma.wallet.findFirstOrThrow({ where: { userId } });
  expect(ff.id).toBe(demoWalletId);
  expect(ff.id).not.toBe(eurWalletId);

  // --- balance: ask for the EUR wallet by id ---
  const bal = await controller.balance(userId, eurWalletId);
  // THE INVARIANT: it reports EUR's currency + balance. Pre-L-1 (findFirst → DEMO)
  // this returns DEMO / 10_000 → both assertions FAIL = genuine fails-first.
  expect(bal.currency).toBe("EUR");
  expect(bal.balance).toBe(Number(eurBalAfter));
  expect(bal.currency).not.toBe("DEMO");
  expect(bal.balance).not.toBe(Number(demoBalance));

  // --- transactions: ask for the EUR wallet by id ---
  const txns = await controller.transactions(userId, eurWalletId);
  // Every returned row belongs to the EUR ledger (the one deposit we made).
  expect(txns.length).toBe(1);
  expect(txns[0].type).toBe("deposit");
  expect(txns[0].amount).toBe(50);
  // Cross-check against the raw EUR ledger to be sure these are EUR's rows, not DEMO's.
  const eurRows = await prisma.ledgerTransaction.findMany({ where: { walletId: eurWalletId } });
  expect(eurRows.length).toBe(1);
  expect(new Set(txns.map((t) => t.id))).toEqual(new Set(eurRows.map((r) => r.id)));

  // Sanity: DEMO has NO ledger rows, so if the controller had resolved DEMO,
  // transactions() would have been empty — confirming the row we got is EUR's.
  const demoRows = await prisma.ledgerTransaction.findMany({ where: { walletId: demoWalletId } });
  expect(demoRows.length).toBe(0);
});

test("L-1 / 2. GUEST FALLBACK: single-wallet user, no walletId → that wallet (unchanged)", async () => {
  const balance = 4_200n;
  const { userId, walletId } = await freshUser(balance);

  // No session walletId (guest path) → findFirst resolves the sole wallet.
  const bal = await controller.balance(userId, undefined);
  expect(bal.currency).toBe("DEMO");
  expect(bal.balance).toBe(Number(balance));

  // And it is specifically THIS user's wallet (getBalance matches the wallet row).
  const w = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
  expect(bal.balance).toBe(Number(w.balance));

  // transactions on the guest path: no rows yet → empty list (no throw).
  const txns = await controller.transactions(userId, undefined);
  expect(txns).toEqual([]);
});

test("L-1 / 3. CROSS-USER: balance/transactions with another user's walletId → ForbiddenException", async () => {
  const a = await freshUser(10_000n);
  const b = await freshUser(9_999n);

  // A presents B's walletId. The ownership guard (w.userId !== userId) must throw.
  let caught: unknown;
  try {
    await controller.balance(a.userId, b.walletId);
    expect.unreachable("balance must throw for another user's walletId");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ForbiddenException);
  expect((caught as ForbiddenException).getResponse()).toMatchObject({ message: "wallet_mismatch" });

  // Same guard on /transactions.
  let caught2: unknown;
  try {
    await controller.transactions(a.userId, b.walletId);
    expect.unreachable("transactions must throw for another user's walletId");
  } catch (e) {
    caught2 = e;
  }
  expect(caught2).toBeInstanceOf(ForbiddenException);

  // INVARIANT: nothing leaked — B's balance was never disclosed and B's wallet is untouched.
  expect(await ledger.getBalance(b.walletId)).toBe(9_999n);
});

// ---------------------------------------------------------------------------
// L-2 — distinct rejected metric for a cross-user / mismatched session walletId.
// ---------------------------------------------------------------------------

test("L-2 / 4. cross-user walletId → reason=wallet_owner_mismatch; non-existent walletId → reason=bet_failed", async () => {
  activeRoundId = await freshRound();
  const a = await freshUser(10_000n);
  const b = await freshUser(10_000n);
  const amount = 100;

  // --- cross-user: A bets presenting B's walletId → WalletOwnershipError path ---
  const mismatchBefore = await rejectedCount("wallet_owner_mismatch");
  const failedBefore = await rejectedCount("bet_failed");

  const r1 = await bets.placeBet(a.userId, "A", amount, undefined, b.walletId);
  // The client sees only a generic bet_failed (no info leak), and no money moved.
  expect(r1.ok).toBe(false);
  expect(r1.reason).toBe("bet_failed");

  const mismatchAfter1 = await rejectedCount("wallet_owner_mismatch");
  const failedAfter1 = await rejectedCount("bet_failed");
  // THE INVARIANT: the DISTINCT series incremented for the mismatch. Pre-L-2 both
  // failures mapped to bet_failed, so wallet_owner_mismatch stays 0 here → FAILS.
  expect(mismatchAfter1).toBe(mismatchBefore + 1);
  // ...and the generic bet_failed counter did NOT move for a mismatch.
  expect(failedAfter1).toBe(failedBefore);

  // No cross-user debit happened.
  expect(await ledger.getBalance(b.walletId)).toBe(10_000n);
  expect(await ledger.getBalance(a.walletId)).toBe(10_000n);
  const aBets = await prisma.bet.findMany({ where: { roundId: activeRoundId, userId: a.userId } });
  expect(aBets.length).toBe(0);

  // --- contrast: a NON-EXISTENT walletId (findUnique throws not-found, NOT a
  // mismatch) must increment bet_failed, NOT wallet_owner_mismatch. ---
  const missingWalletId = randomUUID(); // valid UUID shape, no such wallet
  const r2 = await bets.placeBet(a.userId, "B", amount, undefined, missingWalletId);
  expect(r2.ok).toBe(false);
  expect(r2.reason).toBe("bet_failed");

  const mismatchAfter2 = await rejectedCount("wallet_owner_mismatch");
  const failedAfter2 = await rejectedCount("bet_failed");
  // The mismatch series did NOT move (a not-found is not an ownership violation).
  expect(mismatchAfter2).toBe(mismatchAfter1);
  // The generic series DID move for the not-found case.
  expect(failedAfter2).toBe(failedAfter1 + 1);

  // Still no bet for A this round (panel B not created either).
  const aBetsAfter = await prisma.bet.findMany({ where: { roundId: activeRoundId, userId: a.userId } });
  expect(aBetsAfter.length).toBe(0);
});
