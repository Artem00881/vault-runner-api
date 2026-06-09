import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * Regression for operator-hardening (audit Finding 2): Bet.debitTxId / Bet.payoutTxId
 * must hold an OPERATOR transaction id, which is an ARBITRARY STRING — NOT a uuid.
 *
 * THE BUG (current schema, prisma/schema.prisma ~line 170-171):
 *   debitTxId   String? @map("debit_tx_id")  @db.Uuid
 *   payoutTxId  String? @map("payout_tx_id") @db.Uuid
 * Both columns are Postgres `uuid`. In operator wallet mode the value written here
 * is `OperatorWalletResponse.operatorTxId` (a string) — see
 * src/wallet/seamless-operator-wallet.ts:125 `return { id: res.operatorTxId, ... }`,
 * which src/game/bets.service.ts then persists:
 *   - placeBet activation     bets.service.ts:152  data:{ status:"active", debitTxId: tx.id }
 *   - placeBet best-effort     bets.service.ts:157  data:{ debitTxId: tx.id }
 *   - cashOut                   bets.service.ts:236  data:{ payoutTxId: credit.id }
 *   - reconcile                 bets.service.ts:311  data:{ status:"cashed_out", payoutTxId: credit.id }
 * Writing a non-uuid string into a `uuid` column throws Postgres 22P02
 * "invalid input syntax for type uuid", so operator-mode placeBet / cashOut FAIL.
 *
 * THE FIX (applied by the orchestrator AFTER this test proves the failure — NOT here):
 *   drop `@db.Uuid` from both columns (→ text) + a Prisma migration.
 *
 * THE INVARIANT: an operator transaction id (an opaque string) round-trips through
 * Bet.debitTxId and Bet.payoutTxId — written and read back byte-for-byte.
 *
 * This is a focused, deterministic persistence guard via the SAME write the operator
 * code uses (prisma.bet.update). It seeds the minimal FK chain a Bet needs
 * (chain → seed → round → user/wallet → bet) and uses the real prisma so it exercises
 * the real column type. It MUST FAIL on the current uuid schema (the update throws
 * 22P02) and will PASS once the column becomes `text`.
 *
 * Patterns/seeding/cleanup mirror reserving-recovery-h1.test.ts,
 * operator-reserving-recovery-h1.test.ts and payout-reconcile-h2.test.ts.
 * Needs docker Postgres up.
 */

const prisma = new PrismaService();

// Representative operator transaction ids: NOT uuids (operatorTxId is a free string).
// Table-driven so adding shapes (prefixed, numeric, opaque hash) is one line.
const NON_UUID_TX_IDS: Array<{ label: string; value: string }> = [
  { label: "prefixed-hex", value: "op-tx-9f3a4b2c" },
  { label: "numeric", value: "1234567890" },
  { label: "opaque-hash", value: "TXN_a1B2c3D4e5F6g7H8" },
];

// Track synthetic rows for FK-safe teardown (rounds cascade their bets; users cascade
// wallets/ledger/profiles; seeds then chains last). Synthetic epochs sit far above any
// real epoch so we never touch live fairness data.
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];
const createdBetIds: string[] = [];

/** A FK-valid completed round so a Bet can reference it (round → seed → chain). */
async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 3_000_000 + Math.floor(Math.random() * 1_000_000), // synthetic, distinct range
      commitHash: "txidcommit-" + randomUUID(),
      length: 2,
      salt: "txidsalt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "txidh-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "completed", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** A funded user + wallet (unique username so repeat/parallel runs never collide). */
async function fundedUser(balance: bigint): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "txid_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "txid" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

/** Seed a real Bet row whose txid columns we will then update (as the operator code does). */
async function seedBet(roundId: string, userId: string, walletId: string, panel: "A" | "B"): Promise<string> {
  const id = randomUUID();
  await prisma.bet.create({
    data: { id, roundId, userId, walletId, panel, amount: 100n, status: "active", currency: "DEMO" },
  });
  createdBetIds.push(id);
  return id;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe + leave NO synthetic rows behind (they would break a later read-only
  // fairness scan / pollute the shared dev DB). Order: bets → rounds (cascade any
  // bets) → seeds → chains; then users (cascade wallets/ledger/profile).
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
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

// CORE REGRESSION: a non-uuid operator txid round-trips through debitTxId.
// FAILS on the current uuid schema (the update throws Postgres 22P02); PASSES once
// the column is `text`. Mirrors the placeBet activation write (bets.service.ts:152/157).
test.each(NON_UUID_TX_IDS)(
  "Bet.debitTxId persists a non-uuid operator txid ($label) and reads it back exactly",
  async ({ value }) => {
    const roundId = await freshRound();
    const { userId, walletId } = await fundedUser(10_000n);
    const betId = await seedBet(roundId, userId, walletId, "A");

    // The exact write the operator-mode placeBet does: stamp the operator's
    // (non-uuid) transaction id. On a `uuid` column this throws 22P02.
    await prisma.bet.update({ where: { id: betId }, data: { debitTxId: value } });

    const after = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(after.debitTxId).toBe(value); // byte-for-byte, no coercion
  },
);

// CORE REGRESSION: a non-uuid operator txid round-trips through payoutTxId.
// Mirrors the cashOut / reconcile credit write (bets.service.ts:236/311).
test.each(NON_UUID_TX_IDS)(
  "Bet.payoutTxId persists a non-uuid operator txid ($label) and reads it back exactly",
  async ({ value }) => {
    const roundId = await freshRound();
    const { userId, walletId } = await fundedUser(10_000n);
    const betId = await seedBet(roundId, userId, walletId, "A");

    await prisma.bet.update({ where: { id: betId }, data: { payoutTxId: value } });

    const after = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(after.payoutTxId).toBe(value);
  },
);

// Both columns set in ONE update (the full operator bet lifecycle: debit then win
// land distinct non-uuid ids on the same row). Also proves they remain independent.
test("Bet.debitTxId AND Bet.payoutTxId hold distinct non-uuid operator txids on one row", async () => {
  const roundId = await freshRound();
  const { userId, walletId } = await fundedUser(10_000n);
  const betId = await seedBet(roundId, userId, walletId, "A");

  const debitId = "op-debit-7c1e2f";
  const payoutId = "op-win-3a9d4b0e";

  await prisma.bet.update({
    where: { id: betId },
    data: { status: "cashed_out", debitTxId: debitId, payoutTxId: payoutId },
  });

  const after = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(after.debitTxId).toBe(debitId);
  expect(after.payoutTxId).toBe(payoutId);
  expect(after.status).toBe("cashed_out");
});
