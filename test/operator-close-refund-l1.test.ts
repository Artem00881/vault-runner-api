import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { GameEngineService } from "../src/game/game-engine.service";
import { SeamlessOperatorWallet } from "../src/wallet/seamless-operator-wallet";
import { HttpOperatorWalletApi } from "../src/wallet/http-operator-wallet";
import { startSandboxOperator, type SandboxOperator } from "./helpers/sandbox-operator";
import { makeAudit } from "./helpers/audit";

/**
 * Regression for F-003 (audit L-1, OPERATOR mode): a crash-recovery refund of an
 * interrupted round's still-`active` bet must ROLL BACK the original stake-debit on the
 * operator's statement — NOT post a brand-new `win` credit.
 *
 * THE DEFECT (now fixed): `closeAndRefundRound` refunded via `wallet$.credit(... "refund"
 * ...)`, which in operator mode routed credit → SeamlessOperatorWallet.credit → move("win")
 * → operator.win. The player's balance netted correctly (−stake + stake), so NO money was
 * created/destroyed, but the operator statement recorded `bet` + `win` instead of `bet` +
 * `rollback`, inflating wagering turnover/GGR and breaking the "refund = rollback of
 * original; rollback never increases GGR" model the void path honors.
 *
 * THE FIX under test: the refund now goes through `wallet$.reverse({ originalKey: the
 * stake-debit key, originalDirection: "debit", … })` — the operator rolls back the original
 * `…:debit` (no new turnover); internal/demo mode still posts a `refund` credit (covered by
 * engine-recovery.test.ts, which must keep passing).
 *
 * Wiring mirrors operator-reserving-recovery-h1.test.ts: a SeamlessOperatorWallet over a
 * real-socket sandbox operator + the production GameSessionService.resolver(); recovery is
 * driven through recoverInterruptedRounds() (the boot entry that calls closeAndRefundRound).
 */

const JWT_SECRET = "l1-op-close-refund-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));

const redisStub: any = { client: { set: async () => {} } };
const fairnessStub: any = {};

const debitKey = (roundId: string, userId: string, panel: string) =>
  `bet:${roundId}:${userId}:${panel}:debit`;

const createdOperatorIds: string[] = [];
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdBetIds: string[] = [];
const sandboxes: SandboxOperator[] = [];

/** An OPEN round (so closeAndRefundRound is the path recoverInterruptedRounds takes). */
async function freshOpenRound(status = "running"): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 4_000_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "l1opcommit-" + randomUUID(),
      length: 2,
      salt: "l1opsalt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "l1oph-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status, bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function launchPlayer(currency: string, playerId: string) {
  const op = await prisma.operator.create({
    data: {
      code: "op-l1cr-" + randomUUID().slice(0, 8),
      name: "L1 Close-Refund Operator",
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

function operatorEngine(sandbox: SandboxOperator) {
  const client = new HttpOperatorWalletApi(
    async () => ({ walletApiUrl: sandbox.url, walletApiKey: sandbox.apiKey }),
    { timeoutMs: 1000 },
  );
  const provider = new SeamlessOperatorWallet(client, sessions.resolver());
  const engine = new GameEngineService(prisma, redisStub, fairnessStub, provider, {} as any, {} as any, {} as any);
  // closeAndRefundRound is private; recoverInterruptedRounds() is the boot entry that calls
  // it for every OPEN round (the exact path start() runs), so drive it via that.
  return { recover: () => (engine as any).recoverInterruptedRounds(), provider };
}

async function activeBet(opts: {
  roundId: string; userId: string; walletId: string; panel: "A" | "B"; amount: bigint; debitTxId?: string | null;
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
      status: "active",
      currency: "EUR",
      debitTxId: opts.debitTxId ?? null,
    },
  });
  createdBetIds.push(id);
  return id;
}

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    for (const operatorId of createdOperatorIds) {
      // F-017: user→wallet is RESTRICT — delete child rows first, then the users.
      const opUser = { user: { username: { startsWith: `op:${operatorId}:` } } } as const;
      await prisma.bet.deleteMany({ where: { wallet: opUser } });
      await prisma.ledgerTransaction.deleteMany({ where: { wallet: opUser } });
      await prisma.profile.deleteMany({ where: opUser });
      await prisma.wallet.deleteMany({ where: opUser });
      await prisma.user.deleteMany({ where: { username: { startsWith: `op:${operatorId}:` } } });
    }
    if (createdOperatorIds.length) await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  } catch {
    // never fail the suite on cleanup
  }
  for (const s of sandboxes) s.stop();
  await prisma.$disconnect();
});

// THE F-003 PROOF: operator-mode close+refund of an `active` bet ROLLS BACK the original
// stake-debit (no `win`, no GGR inflation), and the player balance is restored exactly once.
test("F-003 operator: closeAndRefundRound reverses the original debit (rollback), NOT a win credit", async () => {
  const currency = "EUR";
  const playerId = "p-close-" + randomUUID().slice(0, 6);
  const startBalance = 1000;

  const { userId, walletId } = await launchPlayer(currency, playerId);
  const sandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance } });
  sandboxes.push(sandbox);
  const { recover, provider } = operatorEngine(sandbox);

  const roundId = await freshOpenRound("running");
  const key = debitKey(roundId, userId, "A");

  // The original stake-debit on the operator (the `active` bet's debit), under the EXACT key
  // closeAndRefundRound will target for the rollback.
  const tx = await provider.debit(walletId, 100n, "bet_debit", key, { refType: "bet", refId: "stub" });
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(BigInt(startBalance - 100)); // 900 — staked
  expect(sandbox.operator.calls.bet).toBe(1);
  const winsBefore = sandbox.operator.calls.win; // 0
  const rollbacksBefore = sandbox.operator.calls.rollback;

  const betId = await activeBet({ roundId, userId, walletId, panel: "A", amount: 100n, debitTxId: tx.id });

  await recover(); // → closeAndRefundRound(roundId) for this OPEN round

  // THE FIX: the operator saw a ROLLBACK of the stake-debit and NO new win/turnover.
  expect(sandbox.operator.calls.win).toBe(winsBefore); // NO win credit (was the bug: a `win` here inflated GGR)
  expect(sandbox.operator.calls.rollback).toBeGreaterThanOrEqual(rollbacksBefore + 1); // rolled back the original debit
  // Player balance restored exactly once (conservation): back to start.
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(BigInt(startBalance)); // 1000

  // Bet finalized; internal ledger untouched in operator mode (no phantom restart_refund credit).
  expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("cancelled");
  const localRefund = await prisma.ledgerTransaction.findMany({
    where: { idempotencyKey: `bet:${betId}:restart_refund` },
  });
  expect(localRefund.length).toBe(0);
});

// Idempotent: a second recovery pass (crash-loop on boot) must not double-reverse the
// player's stake (the once-only rollback marker / operator idempotency holds).
test("F-003 operator: a second close+refund pass does not double-reverse (idempotent)", async () => {
  const currency = "EUR";
  const playerId = "p-close2-" + randomUUID().slice(0, 6);
  const startBalance = 1000;

  const { userId, walletId } = await launchPlayer(currency, playerId);
  const sandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance } });
  sandboxes.push(sandbox);
  const { recover, provider } = operatorEngine(sandbox);

  const roundId = await freshOpenRound("running");
  const key = debitKey(roundId, userId, "A");
  const tx = await provider.debit(walletId, 250n, "bet_debit", key, { refType: "bet", refId: "stub" });
  await activeBet({ roundId, userId, walletId, panel: "A", amount: 250n, debitTxId: tx.id });

  await recover();
  const afterFirst = sandbox.operator.balanceOf(playerId, currency);
  // Re-open the (now completed) round so a 2nd recovery pass actually re-enters
  // closeAndRefundRound for it (the reverse must stay idempotent on a genuine re-run).
  await prisma.round.update({ where: { id: roundId }, data: { status: "running" } });
  // Re-create the bet row as `active` (the first pass cancelled it) so the 2nd pass attempts
  // the reversal again — proving the operator/once-only guard, not just a status short-circuit.
  await prisma.bet.updateMany({ where: { roundId, userId }, data: { status: "active", settledAt: null } });
  await recover();
  const afterSecond = sandbox.operator.balanceOf(playerId, currency);

  expect(afterFirst).toBe(BigInt(startBalance)); // restored once
  expect(afterSecond).toBe(BigInt(startBalance)); // NOT startBalance + 250 — the reverse is idempotent
});
