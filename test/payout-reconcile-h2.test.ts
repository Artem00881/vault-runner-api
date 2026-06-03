import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { SeamlessOperatorWallet } from "../src/wallet/seamless-operator-wallet";
import { HttpOperatorWalletApi } from "../src/wallet/http-operator-wallet";
import { startSandboxOperator, type SandboxOperator } from "./helpers/sandbox-operator";

/**
 * Audit H2 — reconcilePendingPayouts() completes a stuck operator payout.
 *
 * When an operator credit can't be confirmed, cashOut leaves the bet in
 * `payout_pending` (no claw-back). This DB test proves the recovery half: a
 * payout_pending bet, reconciled in operator mode (SeamlessOperatorWallet over a
 * real-socket sandbox), becomes `cashed_out` with a `payoutTxId`, the operator is
 * credited EXACTLY ONCE (idempotent even across two reconcile passes), and
 * profiles.total_loot increases by the payout exactly once. It also proves the
 * "operator still down" case stays pending and a later pass recovers it.
 *
 * Needs docker Postgres+Redis. We drive the production GameSessionService.resolver()
 * so the provider maps walletId → operator session exactly like prod.
 */

const JWT_SECRET = "h2-reconcile-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt);
const risk = new RiskService();
const metrics = new MetricsService();

// reconcilePendingPayouts / cashOut never touch the engine via reconcile, but
// BetsService requires one in its ctor. Stub it (unused on this path).
const stubEngine: any = {
  getPublicState: () => null,
  currentMultiplier: () => 1.0,
};

// Track synthetic rows for FK-safe teardown.
const createdOperatorIds: string[] = [];
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdBetIds: string[] = [];
const sandboxes: SandboxOperator[] = [];

/** A FK-valid round so a Bet can reference it (rounds → seed → chain). */
async function freshRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 3_000_000 + Math.floor(Math.random() * 1_000_000), // synthetic, distinct range
      commitHash: "h2commit-" + randomUUID(),
      length: 2,
      salt: "h2salt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "h2h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "crashed", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** Launch an operator player → a session whose walletId the resolver maps. */
async function launchPlayer(currency: string, playerId: string) {
  const op = await prisma.operator.create({
    data: {
      code: "op-h2-" + randomUUID().slice(0, 8),
      name: "H2 Reconcile Operator",
      enabled: true,
      launchSecret: "secret-" + randomUUID(),
      currencies: [currency],
    },
  });
  createdOperatorIds.push(op.id);
  const launchToken = await launch.issue({ operatorId: op.id, playerId, currency, locale: "en" });
  const session = await sessions.openFromToken(launchToken);
  const userId = (await prisma.wallet.findUniqueOrThrow({ where: { id: session.walletId } })).userId;
  return { op, session, userId, walletId: session.walletId };
}

/** Seed a Bet already in payout_pending (the state cashOut leaves on a stuck win). */
async function pendingBet(opts: {
  roundId: string;
  userId: string;
  walletId: string;
  panel: "A" | "B";
  amount: bigint;
  payout: bigint;
  cashoutMult: number;
}): Promise<string> {
  const id = randomUUID();
  await prisma.bet.create({
    data: {
      id,
      roundId: opts.roundId,
      userId: opts.userId,
      walletId: opts.walletId,
      panel: opts.panel,
      amount: opts.amount,
      status: "payout_pending",
      cashoutMult: opts.cashoutMult,
      payout: opts.payout,
      debitTxId: null,
      payoutTxId: null,
      settledAt: new Date(),
    },
  });
  createdBetIds.push(id);
  return id;
}

/** Operator-mode BetsService wired to a sandbox via the production resolver. */
function operatorBets(sandbox: SandboxOperator, timeoutMs = 200) {
  const client = new HttpOperatorWalletApi(
    async () => ({ walletApiUrl: sandbox.url, walletApiKey: sandbox.apiKey }),
    { timeoutMs },
  );
  // maxRetries:1 so one armed sandbox timeout fully exhausts retries this pass.
  const provider = new SeamlessOperatorWallet(client, sessions.resolver(), { maxRetries: 1 });
  return new BetsService(prisma, provider, stubEngine, risk, metrics);
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe + leave NO synthetic payout_pending rows behind (they would break a
  // later read-only fairness scan / a fresh reconcile in another run). Order:
  // bets → rounds → seeds → chains; then operator-tagged users; then operators.
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    for (const operatorId of createdOperatorIds) {
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  for (const s of sandboxes) s.stop();
  await prisma.$disconnect();
});

test("H2 reconcile: a healthy operator finalises a payout_pending bet exactly once (idempotent across two passes)", async () => {
  const currency = "EUR";
  const playerId = "p-recon-" + randomUUID().slice(0, 6);
  const startBalance = 1000;
  const payout = 250n;

  const { session, userId, walletId } = await launchPlayer(currency, playerId);
  const sandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance } });
  sandboxes.push(sandbox);
  const bets = operatorBets(sandbox);

  const roundId = await freshRound();
  const betId = await pendingBet({ roundId, userId, walletId, panel: "A", amount: 100n, payout, cashoutMult: 2.5 });

  const lootBefore = (await prisma.profile.findUniqueOrThrow({ where: { userId } })).totalLoot;

  // First reconcile pass → recovers it.
  const recovered = await bets.reconcilePendingPayouts();
  expect(recovered).toBeGreaterThanOrEqual(1); // at least our bet (others may exist in-run)

  // The bet is now finalised: cashed_out + a linked payout tx id.
  const after1 = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(after1.status).toBe("cashed_out");
  expect(after1.payoutTxId).toBeTruthy();

  // The operator was credited exactly once, balance = start + payout.
  expect(sandbox.operator.calls.win).toBe(1);
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(startBalance + Number(payout));

  // Leaderboard loot moved by the payout exactly once.
  const lootAfter1 = (await prisma.profile.findUniqueOrThrow({ where: { userId } })).totalLoot;
  expect(lootAfter1 - lootBefore).toBe(payout);

  // SECOND pass: the bet is no longer payout_pending, so the reconciler won't
  // touch it — no extra win call, balance & loot unchanged (no double-pay).
  const recovered2 = await bets.reconcilePendingPayouts();
  expect(recovered2).toBe(0); // nothing of ours left pending (and we leak none for others)
  const after2 = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(after2.payoutTxId).toBe(after1.payoutTxId); // same tx, not re-issued under a new id
  expect(sandbox.operator.calls.win).toBe(1); // still 1 — idempotent, not re-credited
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(startBalance + Number(payout));
  const lootAfter2 = (await prisma.profile.findUniqueOrThrow({ where: { userId } })).totalLoot;
  expect(lootAfter2).toBe(lootAfter1); // loot did NOT move again
});

test("H2 reconcile: an idempotent retry of an ALREADY-APPLIED win confirms once (operator does not double-credit)", async () => {
  // The scariest case: the win HAD applied at the operator during the original
  // timeout, but our side never saw the reply, so the bet sits payout_pending.
  // The reconciler re-issues the SAME payout key → the operator dedups → the
  // player is paid exactly once and the bet finalises.
  const currency = "USD";
  const playerId = "p-applied-" + randomUUID().slice(0, 6);
  const startBalance = 500;
  const payout = 300n;

  const { userId, walletId } = await launchPlayer(currency, playerId);
  const sandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance } });
  sandboxes.push(sandbox);
  const bets = operatorBets(sandbox);

  const roundId = await freshRound();
  const betId = await pendingBet({ roundId, userId, walletId, panel: "B", amount: 150n, payout, cashoutMult: 2.0 });

  // Simulate the win having already applied at the operator under the SAME key
  // the reconciler will use: `bet:{betId}:payout` (see BetsService.cashOut/reconcile).
  await sandbox.operator.win("op", {
    playerId,
    currency,
    amount: Number(payout),
    transactionId: `bet:${betId}:payout`,
    roundId,
    betId,
  });
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(startBalance + Number(payout)); // already paid
  const winsBefore = sandbox.operator.calls.win; // 1 (our priming call)

  const lootBefore = (await prisma.profile.findUniqueOrThrow({ where: { userId } })).totalLoot;
  const recovered = await bets.reconcilePendingPayouts();
  expect(recovered).toBeGreaterThanOrEqual(1);

  const after = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(after.status).toBe("cashed_out");
  expect(after.payoutTxId).toBeTruthy();

  // Operator was hit again (the reconciler must re-issue) but did NOT re-apply:
  // balance unchanged, dedup on the transactionId. Player paid exactly once.
  expect(sandbox.operator.calls.win).toBe(winsBefore + 1);
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(startBalance + Number(payout));
  // Loot still moves once on OUR finalisation (the journal didn't know it was paid).
  const lootAfter = (await prisma.profile.findUniqueOrThrow({ where: { userId } })).totalLoot;
  expect(lootAfter - lootBefore).toBe(payout);
});

test("H2 reconcile: operator still DOWN → bet stays payout_pending; a later pass once healthy recovers it once", async () => {
  const currency = "GBP";
  const playerId = "p-down-" + randomUUID().slice(0, 6);
  const startBalance = 700;
  const payout = 400n;

  const { userId, walletId } = await launchPlayer(currency, playerId);
  // Short client timeout so the armed hang trips it fast.
  const sandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance } });
  sandboxes.push(sandbox);
  const bets = operatorBets(sandbox, 120);

  const roundId = await freshRound();
  const betId = await pendingBet({ roundId, userId, walletId, panel: "A", amount: 200n, payout, cashoutMult: 2.0 });

  const lootBefore = (await prisma.profile.findUniqueOrThrow({ where: { userId } })).totalLoot;

  // Operator is DOWN: hang past the client timeout WITHOUT applying → the
  // provider throws payout_pending; the reconciler catches it and leaves the bet.
  sandbox.arm({ delayMs: 500 });
  const recovered1 = await bets.reconcilePendingPayouts();

  const downBet = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(downBet.status).toBe("payout_pending"); // STILL pending — not lost, not finalised
  expect(downBet.payoutTxId).toBeNull();
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(startBalance); // not credited
  const lootMid = (await prisma.profile.findUniqueOrThrow({ where: { userId } })).totalLoot;
  expect(lootMid).toBe(lootBefore); // loot untouched while down

  // Operator is HEALTHY again (arm was one-shot): the next pass pays + finalises.
  const recovered2 = await bets.reconcilePendingPayouts();
  expect(recovered2).toBeGreaterThanOrEqual(1);
  expect(recovered2).toBeGreaterThan(recovered1); // it recovered on THIS pass, not the down one

  const healedBet = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(healedBet.status).toBe("cashed_out");
  expect(healedBet.payoutTxId).toBeTruthy();
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(startBalance + Number(payout)); // paid once
  const lootAfter = (await prisma.profile.findUniqueOrThrow({ where: { userId } })).totalLoot;
  expect(lootAfter - lootBefore).toBe(payout); // moved exactly once, only after recovery
});
