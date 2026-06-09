import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { GameEngineService } from "../src/game/game-engine.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { SeamlessOperatorWallet } from "../src/wallet/seamless-operator-wallet";
import { HttpOperatorWalletApi } from "../src/wallet/http-operator-wallet";
import { startSandboxOperator, type SandboxOperator } from "./helpers/sandbox-operator";
import { makeAudit } from "./helpers/audit";

/**
 * Operator-hardening: the PERIODIC, AGE-GATED 'reserving' recovery sweep.
 * `src/game/game-engine.service.ts` recoverReservingBets(olderThanMs) is now
 * PUBLIC and age-gated; `src/game/game.gateway.ts` runs it every 60s with
 * RESERVING_STALE_SEC*1000 (default 120s) in BOTH wallet modes.
 *
 * THE SAFETY PROPERTY UNDER TEST (the whole reason for the age gate):
 *   A 'reserving' slot is the TRANSIENT state of an in-flight placeBet
 *   (reserve → debit → activate, a few seconds). The periodic sweep runs LIVE on
 *   prod, so it MUST NOT touch a slot that is a legitimately mid-flight placeBet —
 *   only genuinely STRANDED ones (createdAt older than the threshold). If the age
 *   gate were missing/wrong, the sweep would refund (internal) or roll back
 *   (operator) a slot that is about to become a valid ACTIVE bet => money
 *   destroyed. These tests pin that gate.
 *
 * Per-bet recovery itself is identical to the boot path (covered by
 * reserving-recovery-h1.test.ts / operator-reserving-recovery-h1.test.ts):
 *   - idempotent wallet$.rollback(debitKey) first (reverses an operator charge /
 *     no-op internal),
 *   - then if an internal ledger debit row exists for that key → refund credit
 *     (`bet:{id}:restart_refund`, idempotent) + set the bet 'cancelled',
 *   - else delete the slot (no money moved).
 * Here we drive recoverReservingBets() DIRECTLY (it is public now) to exercise the
 * age gate via the public API only — no src edits. Redis/Fairness are unused by
 * recovery so they are stubbed.
 */

const STALE_MS = 120_000; // mirrors the gateway default RESERVING_STALE_SEC=120

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const redisStub: any = { client: { set: async () => {} } };
const fairnessStub: any = {};
// INTERNAL-mode engine (LedgerService as the WalletProvider) for cases 1-3.
const internalEngine = new GameEngineService(prisma, redisStub, fairnessStub, ledger, {} as any, {} as any, {} as any);

// Operator-session wiring for case 4 (mirrors operator-reserving-recovery-h1.test.ts).
const OP_JWT_SECRET = "reserving-sweep-op-secret";
const jwt = new JwtService({ secret: OP_JWT_SECRET });
const launch = new LaunchTokenService(jwt, prisma);
const sessions = new GameSessionService(prisma, launch, jwt, new LedgerService(prisma), makeAudit(prisma));

// Deterministic debit key recovery treats as the source of truth.
const debitKey = (roundId: string, userId: string, panel: string) =>
  `bet:${roundId}:${userId}:${panel}:debit`;

// Track synthetic rows for FK-safe teardown. Synthetic epochs sit far above any
// real epoch (3_000_000+) so we never touch live fairness data.
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];
const createdBetIds: string[] = [];
const createdOperatorIds: string[] = [];
const sandboxes: SandboxOperator[] = [];

/**
 * A COMPLETED round so a Bet can reference it (round → seed → chain). 'completed'
 * isolates the reserving path: it is irrelevant to recoverReservingBets() (which
 * runs regardless of round status), and we never call recoverInterruptedRounds()
 * here so the active-bet branch is out of scope anyway.
 */
async function seedCompletedRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 3_000_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "swpcommit-" + randomUUID(),
      length: 2,
      salt: "swpsalt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "swph-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "completed", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function fundedUser(balance: bigint): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "swp_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "swp" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

/**
 * Seed a 'reserving' bet. `ageMs` back-dates createdAt (writable; its
 * @default(now()) only applies when omitted) so we can place a slot on either
 * side of the age gate. ageMs=0 => "young" (createdAt ≈ now).
 */
async function reservingBet(opts: {
  roundId: string;
  userId: string;
  walletId: string;
  panel: "A" | "B";
  amount: bigint;
  ageMs?: number;
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
      currency: "DEMO",
      debitTxId: opts.debitTxId ?? null,
      ...(opts.ageMs ? { createdAt: new Date(Date.now() - opts.ageMs) } : {}),
    },
  });
  createdBetIds.push(id);
  return id;
}

/** Launch an operator player → a live session whose walletId the resolver maps. */
async function launchPlayer(currency: string, playerId: string) {
  const op = await prisma.operator.create({
    data: {
      code: "op-swp-" + randomUUID().slice(0, 8),
      name: "Reserving Sweep Operator",
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
  const engine = new GameEngineService(prisma, redisStub, fairnessStub, provider, {} as any, {} as any, {} as any);
  return { engine, provider };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe + leave NO synthetic 'reserving' rows behind (a stray one would be
  // re-selected by a later boot-recovery / break a read-only fairness scan).
  // Order: explicit bets → bets-by-round → rounds → seeds → chains; then internal
  // users; then operator-tagged users; then operators.
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    // F-017: the swp_ internal users carry a wallet + profile (and the sweep tests write
    // bet_debit/restart_refund ledger rows on those wallets). user→wallet/profile +
    // wallet→ledger/bet are now RESTRICT, so a bare user.deleteMany is REJECTED (and swallowed)
    // and would leak — delete the child rows first: bet → ledger → profile → wallet → user.
    if (createdUserIds.length) {
      await prisma.bet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.ledgerTransaction.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.profile.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    for (const operatorId of createdOperatorIds) {
      // F-017: user→wallet (+ wallet→ledger/bet) is now RESTRICT (was CASCADE) — delete the
      // child rows first, then the users (mirrors reserving-backlog-low4 child-first teardown).
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

// 1) TEETH — the age gate is load-bearing. A YOUNG debited 'reserving' bet (a
//    legitimately in-flight placeBet) is NOT touched by the periodic sweep
//    (olderThanMs=120s), but the SAME young bet IS recovered by boot semantics
//    (olderThanMs=0). The contrast proves the gate using only the public API.
//    A naive sweep without the gate would refund the young bet => money destroyed
//    when it later activates: the first assertion block would fail.
test("TEETH: age gate spares a young in-flight reserving slot (sweep no-ops) but boot (0) recovers the same slot", async () => {
  const roundId = await seedCompletedRound();
  const { userId, walletId } = await fundedUser(10_000n);
  const betId = randomUUID();

  // A YOUNG reserving slot that already carries a real internal ledger debit —
  // i.e. mid-placeBet, right after the debit, about to flip to 'active'. createdAt
  // is ≈ now (no ageMs). Balance is down 100 (money out, as in a live placeBet).
  await prisma.bet.create({
    data: { id: betId, roundId, userId, walletId, panel: "A", amount: 100n, status: "reserving", currency: "DEMO" },
  });
  createdBetIds.push(betId);
  await ledger.debit(walletId, 100n, "bet_debit", debitKey(roundId, userId, "A"), {
    refType: "bet",
    refId: betId,
  });
  expect(await ledger.getBalance(walletId)).toBe(9_900n);

  // The periodic sweep (120s gate) must SKIP this young slot entirely.
  const sweptYoung = await internalEngine.recoverReservingBets(STALE_MS);
  expect(sweptYoung).toBe(0); // nothing processed
  // Slot untouched: still 'reserving', NOT refunded (no clawback of an in-flight bet).
  const stillReserving = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(stillReserving.status).toBe("reserving");
  expect(stillReserving.settledAt).toBeNull();
  expect(await ledger.getBalance(walletId)).toBe(9_900n); // money NOT restored — bet may still win
  // No phantom refund credit was written for the young slot.
  expect(
    (await prisma.ledgerTransaction.findMany({ where: { idempotencyKey: `bet:${betId}:restart_refund` } })).length,
  ).toBe(0);

  // CONTRAST: boot semantics (olderThanMs=0) recover the very SAME young bet — this
  // is what proves the first block was gated by AGE, not by some other property of
  // the row. (On boot no placeBet is in flight, so recovering all is safe.)
  const sweptBoot = await internalEngine.recoverReservingBets(0);
  expect(sweptBoot).toBeGreaterThanOrEqual(1);
  const recovered = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(recovered.status).toBe("cancelled");
  expect(recovered.settledAt).not.toBeNull();
  expect(await ledger.getBalance(walletId)).toBe(10_000n); // refunded
});

// 2) STALE + DEBITED (internal): an OLD reserving slot with its ledger debit is
//    refunded by the sweep, the stake restored, status 'cancelled'; a SECOND sweep
//    is idempotent (deterministic restart_refund key — no double refund).
test("internal: a stale debited reserving slot is refunded by the sweep, idempotently (returns 1 then 0)", async () => {
  const roundId = await seedCompletedRound();
  const { userId, walletId } = await fundedUser(10_000n);

  const betId = await reservingBet({ roundId, userId, walletId, panel: "A", amount: 100n, ageMs: 10 * 60 * 1000 });
  await ledger.debit(walletId, 100n, "bet_debit", debitKey(roundId, userId, "A"), { refType: "bet", refId: betId });
  expect(await ledger.getBalance(walletId)).toBe(9_900n); // money out

  // First sweep: old enough → processed and refunded.
  const n1 = await internalEngine.recoverReservingBets(STALE_MS);
  expect(n1).toBeGreaterThanOrEqual(1);
  const after = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(after.status).toBe("cancelled");
  expect(after.settledAt).not.toBeNull();
  expect(await ledger.getBalance(walletId)).toBe(10_000n); // stake restored

  // Second sweep: the slot is already 'cancelled' (not re-selected) AND the
  // restart_refund key is idempotent → balance stays put, nothing processed.
  const n2 = await internalEngine.recoverReservingBets(STALE_MS);
  expect(n2).toBe(0);
  expect(await ledger.getBalance(walletId)).toBe(10_000n); // not 10_100n

  // Exactly one refund (credit) ledger row exists for this bet.
  const refunds = await prisma.ledgerTransaction.findMany({
    where: { idempotencyKey: `bet:${betId}:restart_refund` },
  });
  expect(refunds.length).toBe(1);
  expect(refunds[0].amount).toBe(100n); // positive credit
});

// 3) STALE + NOT DEBITED (internal): an OLD reserving slot with no ledger debit
//    moved no money → the sweep deletes the slot, balance unchanged.
test("internal: a stale reserving slot with NO ledger debit is deleted by the sweep, balance unchanged", async () => {
  const roundId = await seedCompletedRound();
  const { walletId } = await fundedUser(10_000n);
  // Reuse a distinct user for clarity: fund a fresh one and read its id back.
  const { userId } = await fundedUser(10_000n);
  void walletId; // (the first fundedUser is unused; keep ids unique per case)

  // Resolve THIS user's wallet (fundedUser returns it, but we created two — use the
  // second user's wallet to keep the debit-key namespace clean).
  const wallet = await prisma.wallet.findFirstOrThrow({ where: { userId } });
  const betId = await reservingBet({
    roundId,
    userId,
    walletId: wallet.id,
    panel: "A",
    amount: 100n,
    ageMs: 10 * 60 * 1000,
  });
  expect(await ledger.getBalance(wallet.id)).toBe(10_000n);

  const n = await internalEngine.recoverReservingBets(STALE_MS);
  expect(n).toBeGreaterThanOrEqual(1);

  // Slot gone (no exposure dust), and NOT refunded (no money had moved).
  expect(await prisma.bet.findUnique({ where: { id: betId } })).toBeNull();
  expect(await ledger.getBalance(wallet.id)).toBe(10_000n);
  expect(
    (await prisma.ledgerTransaction.findMany({ where: { idempotencyKey: `bet:${betId}:restart_refund` } })).length,
  ).toBe(0);
});

// 4) OPERATOR mode: an OLD reserving slot whose debit went to an OPERATOR has its
//    operator charge rolled back by the sweep. A debit writes NO local ledger row,
//    so the rollback (not the internal-credit branch) is what reverses the charge.
test("operator: the sweep rolls back the operator charge for a stale debited reserving slot", async () => {
  const currency = "EUR";
  const playerId = "p-sweep-" + randomUUID().slice(0, 6);
  const startBalance = 1000;

  const { userId, walletId } = await launchPlayer(currency, playerId);
  const sandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance } });
  sandboxes.push(sandbox);
  const { engine, provider } = operatorEngine(sandbox);

  const roundId = await seedCompletedRound();
  const key = debitKey(roundId, userId, "A");

  // Actually debit the operator wallet under the deterministic key the sweep rolls
  // back — the post-debit/pre-activation crash state in OPERATOR mode.
  const tx = await provider.debit(walletId, 100n, "bet_debit", key, { refType: "bet", refId: "stub" });
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(BigInt(startBalance - 100)); // 900 — money out at operator
  expect(sandbox.operator.calls.bet).toBe(1);

  // Seed the OLD stuck reserving row (best-effort debitTxId stamped, as real
  // placeBet would attempt — recovery uses the rollback + ledger, not this column).
  const betId = await reservingBet({
    roundId,
    userId,
    walletId,
    panel: "A",
    amount: 100n,
    ageMs: 10 * 60 * 1000,
    debitTxId: tx.id,
  });

  // Operator-mode precondition: a debit writes NO local ledger row, so the rollback
  // branch (not the internal credit) is the one that reverses the charge.
  expect(await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: key } })).toBeNull();

  const rollbacksBefore = sandbox.operator.calls.rollback;

  const n = await engine.recoverReservingBets(STALE_MS);
  expect(n).toBeGreaterThanOrEqual(1);

  // The operator charge was REVERSED: a rollback was made for this txId and the
  // balance is back to start. THIS is the money-conservation proof for the sweep.
  expect(sandbox.operator.calls.rollback).toBeGreaterThanOrEqual(rollbacksBefore + 1);
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(BigInt(startBalance)); // 1000 — fully restored

  // The stuck slot is gone (no local debit row → dropped after rollback), and the
  // internal ledger was never touched (no phantom local refund/debit conjured).
  expect(await prisma.bet.findUnique({ where: { id: betId } })).toBeNull();
  expect(
    (await prisma.ledgerTransaction.findMany({ where: { idempotencyKey: `bet:${betId}:restart_refund` } })).length,
  ).toBe(0);
  expect(await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: key } })).toBeNull();
});

// 5) OPERATOR mode age gate: a YOUNG operator-debited reserving slot is NOT swept
//    (no rollback, balance stays debited because the bet may still win). Mirrors
//    the TEETH case for the operator path.
test("operator: the sweep spares a young operator-debited reserving slot (no rollback)", async () => {
  const currency = "USD";
  const playerId = "p-sweep-young-" + randomUUID().slice(0, 6);
  const startBalance = 1000;

  const { userId, walletId } = await launchPlayer(currency, playerId);
  const sandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance } });
  sandboxes.push(sandbox);
  const { engine, provider } = operatorEngine(sandbox);

  const roundId = await seedCompletedRound();
  const key = debitKey(roundId, userId, "A");

  const tx = await provider.debit(walletId, 100n, "bet_debit", key, { refType: "bet", refId: "stub" });
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(BigInt(startBalance - 100)); // 900

  // YOUNG slot (createdAt ≈ now) — an in-flight placeBet about to activate.
  const betId = await reservingBet({ roundId, userId, walletId, panel: "A", amount: 100n, debitTxId: tx.id });

  const rollbacksBefore = sandbox.operator.calls.rollback;
  const n = await engine.recoverReservingBets(STALE_MS);

  // The young slot is SKIPPED: nothing processed, NO rollback, the operator debit
  // stands (the bet may still become active and win). Destroying it here = money bug.
  expect(n).toBe(0);
  expect(sandbox.operator.calls.rollback).toBe(rollbacksBefore); // no rollback issued
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(BigInt(startBalance - 100)); // still 900
  expect((await prisma.bet.findUniqueOrThrow({ where: { id: betId } })).status).toBe("reserving"); // untouched
});
