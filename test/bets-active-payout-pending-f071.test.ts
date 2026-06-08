import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { BetsController } from "../src/game/bets.controller";

/**
 * Regression for F-071: GET /api/bets/active (the reconnect resync) must include
 * `payout_pending` bets — a bet that WON but whose operator payout hasn't confirmed is
 * still owed money the reconnecting player must see. Previously the query filtered
 * `status:"active"` only, so an owed `payout_pending` win vanished from the UI on reconnect.
 *
 * Money is safe either way (the reconciler keeps retrying); this is a player-facing display
 * fix. Read-only — we drive BetsController.active(userId) directly over real Prisma rows.
 */

const prisma = new PrismaService();
const controller = new BetsController(prisma);

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];

async function seedRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 5_000_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "f071c-" + randomUUID(),
      length: 2,
      salt: "f071s-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "f071h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "completed", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function freshUserWallet(): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "f071_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance: 10000n } },
      profile: { create: { displayName: "f071" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  try {
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    for (const userId of createdUserIds) {
      // F-017: wallet→bet/ledger is RESTRICT — clear child rows before the user.
      await prisma.bet.deleteMany({ where: { userId } });
      await prisma.ledgerTransaction.deleteMany({ where: { wallet: { userId } } });
      await prisma.profile.deleteMany({ where: { userId } });
      await prisma.wallet.deleteMany({ where: { userId } });
    }
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  await prisma.$disconnect();
});

test("F-071: /api/bets/active returns BOTH active and payout_pending (owed win), with its payout", async () => {
  const roundId = await seedRound();
  // The resync is scoped by userId, so all three bets belong to the SAME user. The
  // @@unique([roundId,userId,panel]) means one bet per panel — use A for active, B for the
  // pending win, and a SECOND round for the busted bet (a user can't have two A-panel bets in
  // one round; the resync isn't round-scoped anyway, so a second round still proves exclusion).
  const { userId, walletId } = await freshUserWallet();
  const roundId2 = await seedRound();

  const activeId = randomUUID();
  const pendingId = randomUUID();
  const bustedId = randomUUID();
  await prisma.bet.create({
    data: { id: activeId, roundId, userId, walletId, panel: "A", amount: 100n, status: "active" },
  });
  // A won-but-unconfirmed payout: payout_pending carries a real owed payout.
  await prisma.bet.create({
    data: { id: pendingId, roundId, userId, walletId, panel: "B", amount: 50n, status: "payout_pending", payout: 175n, cashoutMult: 3.5 },
  });
  // A terminal busted bet must NOT appear in the resync.
  await prisma.bet.create({
    data: { id: bustedId, roundId: roundId2, userId, walletId, panel: "A", amount: 25n, status: "busted" },
  });

  const rows = await controller.active(userId);
  const ids = rows.map((r) => r.id);

  expect(ids).toContain(activeId); // active still surfaces (unchanged)
  expect(ids).toContain(pendingId); // F-071: the owed pending win now surfaces
  expect(ids).not.toContain(bustedId); // terminal — excluded

  // The pending row carries its owed payout so the UI can show "win pending confirmation".
  const pending = rows.find((r) => r.id === pendingId)!;
  expect(pending.status).toBe("payout_pending");
  expect(pending.payout).toBe(175);
});

test("F-071: a user with ONLY a payout_pending bet still sees it on resync (was empty before)", async () => {
  const roundId = await seedRound();
  const { userId, walletId } = await freshUserWallet();
  const pendingId = randomUUID();
  await prisma.bet.create({
    data: { id: pendingId, roundId, userId, walletId, panel: "A", amount: 80n, status: "payout_pending", payout: 240n },
  });

  const rows = await controller.active(userId);
  expect(rows.map((r) => r.id)).toEqual([pendingId]);
  expect(rows[0].payout).toBe(240);
});
