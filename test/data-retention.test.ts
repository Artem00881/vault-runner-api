import { test, expect, beforeAll, afterAll } from "bun:test";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * Audit F-017 — MONEY-RECORD RETENTION (FK CASCADE → RESTRICT).
 *
 * Six relations on money-bearing / account tables were flipped from ON DELETE CASCADE to
 * ON DELETE RESTRICT (migration 20260608120000_fk_restrict_money_records): Wallet.user,
 * LedgerTransaction.wallet, Bet.round, Bet.user, Bet.wallet, Profile.user. The point: a
 * delete that would orphan or erase a money record (ledger row / bet) is now REFUSED at the
 * DB level instead of silently cascading the financial journal away — PII is anonymized in
 * place instead (see data-erasure.test.ts).
 *
 * This suite proves the RESTRICT guard fires (Prisma surfaces a foreign-key violation as
 * P2003) and that the journal stays intact when a delete is refused. It also proves the
 * positive: anonymizing PII fields in place keeps every FK valid and every money column
 * byte-identical. Needs docker Postgres. Child-first teardown, all in try/catch.
 */

const prisma = new PrismaService();

// Track everything for FK-safe (child-first) teardown.
const createdBetIds: string[] = [];
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdWalletIds: string[] = [];
const createdUserIds: string[] = [];

/** A FK-valid round (round → seed → chain). Synthetic epoch in a distinct range. */
async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 6_100_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "ret-" + randomUUID(),
      length: 2,
      salt: "ret-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "ret-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "crashed", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** A user + wallet + profile, optionally seeded with a ledger row + a (busted) bet. */
async function freshFixture(opts: { withLedgerAndBet: boolean }): Promise<{
  userId: string;
  walletId: string;
  betId?: string;
}> {
  const user = await prisma.user.create({
    data: {
      username: "ret-" + randomUUID(),
      isGuest: true,
      wallets: { create: { currency: "DEMO", balance: 10_000n } },
      profile: { create: { displayName: "ret-player" } },
    },
    include: { wallets: true },
  });
  const walletId = user.wallets[0].id;
  createdUserIds.push(user.id);
  createdWalletIds.push(walletId);

  let betId: string | undefined;
  if (opts.withLedgerAndBet) {
    const roundId = await freshRound();
    betId = randomUUID();
    await prisma.bet.create({
      data: { id: betId, roundId, userId: user.id, walletId, panel: "A", amount: 100n, status: "busted", payout: 0n },
    });
    createdBetIds.push(betId);
    // A debit ledger row referencing the wallet (the money journal we must retain).
    await prisma.ledgerTransaction.create({
      data: {
        walletId,
        type: "bet_debit",
        amount: -100n,
        balanceAfter: 9_900n,
        refType: "bet",
        refId: betId,
        idempotencyKey: "ret:" + randomUUID(),
      },
    });
  }
  return { userId: user.id, walletId, betId };
}

/** True iff the rejected promise is a Prisma foreign-key-violation (P2003). */
async function rejectsWithP2003(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
  }
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // Child-first teardown (bets → ledger → rounds → seeds → chains → wallets → users).
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdWalletIds.length) await prisma.ledgerTransaction.deleteMany({ where: { walletId: { in: createdWalletIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    // F-017: freshFixture creates a Profile for EVERY user; Profile.user is now RESTRICT, so
    // the user.deleteMany below is REJECTED (and swallowed) and the user+profile+wallet leak
    // unless the profile is removed first. Delete profiles before wallets/users.
    if (createdUserIds.length) await prisma.profile.deleteMany({ where: { userId: { in: createdUserIds } } });
    if (createdWalletIds.length) await prisma.wallet.deleteMany({ where: { id: { in: createdWalletIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

test("F-017: deleting a user with bets/ledger is REJECTED (P2003) and the journal is intact", async () => {
  const { userId, walletId, betId } = await freshFixture({ withLedgerAndBet: true });

  // user.delete → blocked (Wallet.user is RESTRICT; the wallet still exists).
  expect(await rejectsWithP2003(prisma.user.delete({ where: { id: userId } }))).toBe(true);

  // The whole journal survived the refused delete, byte-for-byte.
  expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
  expect(await prisma.wallet.count({ where: { id: walletId } })).toBe(1);
  expect(await prisma.ledgerTransaction.count({ where: { walletId } })).toBe(1);
  expect(await prisma.bet.count({ where: { id: betId! } })).toBe(1);
});

test("F-017: deleting a wallet while ledger/bets reference it is REJECTED (P2003)", async () => {
  const { walletId } = await freshFixture({ withLedgerAndBet: true });

  // wallet.delete → blocked (LedgerTransaction.wallet AND Bet.wallet are both RESTRICT).
  expect(await rejectsWithP2003(prisma.wallet.delete({ where: { id: walletId } }))).toBe(true);
  expect(await prisma.wallet.count({ where: { id: walletId } })).toBe(1);
  expect(await prisma.ledgerTransaction.count({ where: { walletId } })).toBe(1);
});

test("F-017: deleting a round while a bet references it is REJECTED (P2003)", async () => {
  const { betId } = await freshFixture({ withLedgerAndBet: true });
  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: betId! } });

  // round.delete → blocked (Bet.round is RESTRICT).
  expect(await rejectsWithP2003(prisma.round.delete({ where: { id: bet.roundId } }))).toBe(true);
  expect(await prisma.round.count({ where: { id: bet.roundId } })).toBe(1);
  expect(await prisma.bet.count({ where: { id: betId! } })).toBe(1);
});

test("F-017: a user with ONLY a wallet + profile (no bets/ledger) is ALSO not deletable", async () => {
  // Even with no money rows yet, Wallet.user + Profile.user are RESTRICT — the account
  // record can't be erased by a bare user.delete; it must be anonymized in place.
  const { userId, walletId } = await freshFixture({ withLedgerAndBet: false });

  expect(await rejectsWithP2003(prisma.user.delete({ where: { id: userId } }))).toBe(true);
  expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
  expect(await prisma.wallet.count({ where: { id: walletId } })).toBe(1);
  expect(await prisma.profile.count({ where: { userId } })).toBe(1);
});

test("F-017: anonymize-in-place keeps every FK valid and money byte-identical", async () => {
  const { userId, walletId, betId } = await freshFixture({ withLedgerAndBet: true });

  const balanceBefore = (await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } })).balance;
  const ledgerSumBefore = (await prisma.ledgerTransaction.aggregate({ where: { walletId }, _sum: { amount: true } }))._sum.amount;
  const betBefore = await prisma.bet.findUniqueOrThrow({ where: { id: betId! } });

  // Scrub PII fields in place (the shape DataErasureService uses) — money columns untouched.
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { username: "anon:" + userId.slice(0, 12), anonymizedAt: new Date() } }),
    prisma.profile.update({ where: { userId }, data: { displayName: "anon" } }),
  ]);

  // Every FK still resolves: wallet → user, ledger → wallet, bet → user/wallet/round.
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  expect(user.anonymizedAt).not.toBeNull();
  expect(await prisma.wallet.count({ where: { id: walletId, userId } })).toBe(1);
  expect(await prisma.ledgerTransaction.count({ where: { walletId } })).toBe(1);

  // Money is byte-identical before/after.
  expect((await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } })).balance).toBe(balanceBefore);
  expect((await prisma.ledgerTransaction.aggregate({ where: { walletId }, _sum: { amount: true } }))._sum.amount).toBe(ledgerSumBefore);
  const betAfter = await prisma.bet.findUniqueOrThrow({ where: { id: betId! } });
  expect(betAfter.amount).toBe(betBefore.amount);
  expect(betAfter.payout).toBe(betBefore.payout);
  expect(betAfter.status).toBe(betBefore.status);
});
