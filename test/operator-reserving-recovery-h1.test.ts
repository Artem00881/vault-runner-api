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

/**
 * Regression for audit H1 re-review, Finding 1 (OPERATOR mode): money is NEVER
 * destroyed when a bet is left stuck in 'reserving' AFTER its operator wallet was
 * debited. `src/game/game-engine.service.ts` recoverReservingBets(),
 * docs/audit-2026-06-03.md H1.
 *
 * THE FIX under test:
 *  - recoverReservingBets() now issues an IDEMPOTENT
 *    `wallet$.rollback(walletId, debitKey, {refId})` for EVERY 'reserving' bet
 *    BEFORE the local-ledger check. In OPERATOR mode a debit writes NO local
 *    `ledgerTransaction` row, so the OLD code (which only refunded via the
 *    internal-ledger branch and otherwise DELETED the row) would silently destroy
 *    a debited-but-stuck operator bet — the player stayed charged with no bet and
 *    no refund. The rollback reverses the operator charge (idempotent: it no-ops
 *    if the operator never applied the debit, and reverses it if it did).
 *
 * THE INVARIANT (was violated in operator mode): conservation of money. A
 * debited-but-unactivated operator bet must have its operator charge reversed; an
 * un-debited reservation must leave the operator balance untouched (safe no-op).
 *
 * Wiring mirrors operator-session-c2.test.ts / payout-reconcile-h2.test.ts: a
 * SeamlessOperatorWallet over a real-socket sandbox operator + the production
 * GameSessionService.resolver(). Recovery is driven through the SAME private boot
 * entry the engine uses on start (recoverInterruptedRounds → recoverReservingBets),
 * exactly like reserving-recovery-h1.test.ts / engine-recovery.test.ts. The engine
 * is constructed in OPERATOR mode by passing the SeamlessOperatorWallet as its
 * WalletProvider. Redis/Fairness are unused by recovery so they are stubbed.
 */

const JWT_SECRET = "h1-op-reserving-secret";
const jwt = new JwtService({ secret: JWT_SECRET });
const prisma = new PrismaService();
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma));

const redisStub: any = { client: { set: async () => {} } };
const fairnessStub: any = {};

// Deterministic debit key recovery uses as the source of truth — and the SAME key
// we hand the operator debit so its rollback finds the applied charge.
const debitKey = (roundId: string, userId: string, panel: string) =>
  `bet:${roundId}:${userId}:${panel}:debit`;

// Track synthetic rows for FK-safe teardown. Synthetic epochs sit far above any
// real epoch so we never touch live fairness data.
const createdOperatorIds: string[] = [];
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdBetIds: string[] = [];
const sandboxes: SandboxOperator[] = [];

/**
 * A COMPLETED round so a Bet can reference it (rounds → seed → chain). Completed
 * isolates the reserving-recovery path: recoverInterruptedRounds' OTHER branch
 * (which refunds *active* bets of OPEN rounds) won't touch our reserving rows.
 */
async function freshCompletedRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 3_000_000 + Math.floor(Math.random() * 1_000_000), // synthetic, distinct range
      commitHash: "h1opcommit-" + randomUUID(),
      length: 2,
      salt: "h1opsalt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "h1oph-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "completed", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** Launch an operator player → a live session whose walletId the resolver maps. */
async function launchPlayer(currency: string, playerId: string) {
  const op = await prisma.operator.create({
    data: {
      code: "op-h1r-" + randomUUID().slice(0, 8),
      name: "H1 Reserving Recovery Operator",
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

/** Build an OPERATOR-mode engine over a sandbox via the production resolver. */
function operatorEngine(sandbox: SandboxOperator) {
  const client = new HttpOperatorWalletApi(
    async () => ({ walletApiUrl: sandbox.url, walletApiKey: sandbox.apiKey }),
    { timeoutMs: 1000 },
  );
  const provider = new SeamlessOperatorWallet(client, sessions.resolver());
  const engine = new GameEngineService(prisma, redisStub, fairnessStub, provider, {} as any);
  // recoverReservingBets() is private; drive it via recoverInterruptedRounds() —
  // the exact entry start() calls on boot (reserving-recovery-h1.test.ts does the
  // same). Returns the WalletProvider too so a test can debit directly.
  return { recover: () => (engine as any).recoverInterruptedRounds(), provider };
}

/** Seed a 'reserving' bet row (the transient pre-activation state). */
async function reservingBet(opts: {
  roundId: string;
  userId: string;
  walletId: string;
  panel: "A" | "B";
  amount: bigint;
  debitTxId?: string | null;
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
      status: "reserving",
      debitTxId: opts.debitTxId ?? null,
    },
  });
  createdBetIds.push(id);
  return id;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe + leave NO synthetic reserving rows behind (they would be re-selected
  // by a later boot-recovery / break a read-only fairness scan). Order:
  // bets → rounds → seeds → chains; then operator-tagged users; then operators.
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
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

// 1) OPERATOR-DEBITED, stuck 'reserving' bet → operator charge ROLLED BACK
//    (money restored). The money-conservation proof for operator mode: the OLD
//    code would have DELETED this row, stranding the operator charge forever.
test("H1 operator: a debited 'reserving' bet has its operator charge rolled back by recovery (money restored)", async () => {
  const currency = "EUR";
  const playerId = "p-debited-" + randomUUID().slice(0, 6);
  const startBalance = 1000;

  const { userId, walletId } = await launchPlayer(currency, playerId);
  const sandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance } });
  sandboxes.push(sandbox);
  const { recover, provider } = operatorEngine(sandbox);

  const roundId = await freshCompletedRound();
  const key = debitKey(roundId, userId, "A");

  // The post-debit/pre-activation crash state in OPERATOR mode: the operator
  // wallet was ACTUALLY debited (balance is down), under the deterministic key
  // recovery rolls back, but the row never flipped to 'active'. Debit via the
  // SAME provider the engine uses so the operator records the applied delta.
  const tx = await provider.debit(walletId, 100n, "bet_debit", key, { refType: "bet", refId: "stub" });
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(startBalance - 100); // 900 — money out at operator
  expect(sandbox.operator.calls.bet).toBe(1);

  // Seed the stuck reserving row (best-effort debitTxId stamped, as the real
  // placeBet would attempt — recovery uses the rollback + ledger, not this column).
  const betId = await reservingBet({ roundId, userId, walletId, panel: "A", amount: 100n, debitTxId: tx.id });

  // CRITICAL precondition for operator mode: a debit writes NO local ledger row.
  // (If one existed, the internal-credit branch — not the rollback — would handle
  // it; this test specifically covers the operator-only path.)
  const localDebit = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: key } });
  expect(localDebit).toBeNull();

  const rollbacksBefore = sandbox.operator.calls.rollback;

  await recover();

  // The operator charge was REVERSED: balance restored to start, and the operator
  // saw a rollback for this transactionId. THIS is the money-conservation proof.
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(startBalance); // 1000 — fully restored
  expect(sandbox.operator.calls.rollback).toBeGreaterThanOrEqual(rollbacksBefore + 1);

  // The stuck slot is gone (no internal debit row → recovery drops it after the
  // rollback; no exposure dust left behind).
  expect(await prisma.bet.findUnique({ where: { id: betId } })).toBeNull();

  // The internal ledger was NOT touched: no phantom local refund credit, and no
  // local debit row was conjured. Operator is the sole source of truth here.
  const localRefund = await prisma.ledgerTransaction.findMany({
    where: { idempotencyKey: `bet:${betId}:restart_refund` },
  });
  expect(localRefund.length).toBe(0);
  expect(await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: key } })).toBeNull();
});

// 2) OPERATOR-NOT-DEBITED 'reserving' bet → rollback is a safe NO-OP. The slot is
//    dropped and the operator balance is untouched (idempotent rollback no-op).
test("H1 operator: a 'reserving' bet with NO operator debit — recovery's rollback is a safe no-op, balance unchanged", async () => {
  const currency = "USD";
  const playerId = "p-undebited-" + randomUUID().slice(0, 6);
  const startBalance = 500;

  const { userId, walletId } = await launchPlayer(currency, playerId);
  const sandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance } });
  sandboxes.push(sandbox);
  const { recover } = operatorEngine(sandbox);

  const roundId = await freshCompletedRound();

  // A reservation that never debited (crashed between the reserve insert and the
  // operator debit). The operator never applied a charge for this slot's key.
  const betId = await reservingBet({ roundId, userId, walletId, panel: "A", amount: 100n });
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(startBalance); // 500 — nothing moved yet
  expect(sandbox.operator.calls.bet).toBe(0);

  await recover();

  // The rollback for an un-applied transactionId is a no-op at the operator:
  // balance is UNCHANGED. (The call may still be made — idempotent by design.)
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(startBalance); // 500 — untouched

  // The slot is dropped (no internal debit row → deleted), no phantom credit.
  expect(await prisma.bet.findUnique({ where: { id: betId } })).toBeNull();
  const localRefund = await prisma.ledgerTransaction.findMany({
    where: { idempotencyKey: `bet:${betId}:restart_refund` },
  });
  expect(localRefund.length).toBe(0);
});
