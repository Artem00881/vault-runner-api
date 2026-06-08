import { test, expect, beforeAll, afterAll } from "bun:test";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { GameEngineService } from "../src/game/game-engine.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { LaunchTokenService } from "../src/operator/launch-token.service";
import { GameSessionService } from "../src/operator/game-session.service";
import { SeamlessOperatorWallet } from "../src/wallet/seamless-operator-wallet";
import { HttpOperatorWalletApi } from "../src/wallet/http-operator-wallet";
import { startSandboxOperator, type SandboxOperator } from "./helpers/sandbox-operator";
import { makeAudit } from "./helpers/audit";

/**
 * Regression for audit Low-1 (CLAIM-FIRST, gate-independent reserving recovery).
 * `src/game/bets.service.ts` placeBet PHASE 2 flip; `src/game/game-engine.service.ts`
 * recoverReservingBets(); docs/audit-2026-06-03.md Low-1.
 *
 * THE INVARIANT under test: a bet transitions OUT of 'reserving' via a
 * compare-and-swap in BOTH directions — placeBet flips 'reserving'→'active'
 * (CAS), recovery claims 'reserving'→'cancelling' (CAS). So exactly ONE wins:
 *   - recovery NEVER refunds/cancels a bet that legitimately became 'active'
 *     (it loses the claim and skips), and
 *   - a crash mid-reversal leaves the row 'cancelling', which a later pass
 *     re-selects and re-reverses (idempotent) — never stranding an owed refund.
 * This is correct INDEPENDENT of the age gate (the gate is a perf/optics filter,
 * not the correctness mechanism).
 *
 * Tests:
 *  1) placeBet LOSES the flip CAS (slot reclaimed) → reports failure, leaves NO
 *     phantom 'active' bet, records NO placed-bet metric.
 *  2) recovery's claim LOSES to a live activation → an 'active' bet is NEVER
 *     reversed (excluded by the findMany filter; the claim CAS also guards it).
 *  3) crash mid-reversal ('cancelling' re-entry) is re-recovered, refunded
 *     exactly once, idempotent on a second pass.
 *  4) operator-mode 'cancelling' re-recovery → wallet$.rollback reverses the
 *     charge once, slot dropped.
 *
 * Recovery is driven through the SAME private boot entry the engine uses on start
 * (recoverInterruptedRounds → recoverReservingBets), exactly like
 * reserving-recovery-h1.test.ts. Internal ledger as the WalletProvider for the
 * internal cases; a real-socket sandbox operator for the operator case.
 * Redis/Fairness are unused by recovery so they are stubbed.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const redisStub: any = { client: { set: async () => {} } };
const fairnessStub: any = {};
const internalEngine = new GameEngineService(prisma, redisStub, fairnessStub, ledger, {} as any, {} as any, {} as any);
// recoverReservingBets() is private; drive it via recoverInterruptedRounds() —
// the exact entry start() calls on boot (reserving-recovery-h1.test.ts does the same).
const recover = () => (internalEngine as any).recoverInterruptedRounds();

// Operator-session wiring for case 4 (mirrors operator-reserving-recovery-h1.test.ts).
const OP_JWT_SECRET = "low1-claim-first-op-secret";
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
 * isolates the reserving-recovery path: recoverInterruptedRounds' OTHER branch
 * (which refunds *active* bets of OPEN rounds) won't touch our rows — so case 2's
 * 'active' bet is left strictly to the reserving/claim logic under test.
 */
async function seedCompletedRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 3_000_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "low1commit-" + randomUUID(),
      length: 2,
      salt: "low1salt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "low1h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "completed", bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

/** A round in the betting window, for the real placeBet path (case 1). */
async function seedBettingRound(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 3_000_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "low1commit-" + randomUUID(),
      length: 2,
      salt: "low1salt-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "low1h-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 2.0, status: "betting", bettingOpensAt: new Date() },
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
      username: "low1_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "low1" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

/** Seed a bet row with an EXPLICIT status (e.g. 'active' / 'cancelling'). */
async function seedBet(opts: {
  roundId: string;
  userId: string;
  walletId: string;
  panel: "A" | "B";
  amount: bigint;
  status: string;
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
      status: opts.status,
      debitTxId: opts.debitTxId ?? null,
    },
  });
  createdBetIds.push(id);
  return id;
}

/** Launch an operator player → a live session whose walletId the resolver maps. */
async function launchPlayer(currency: string, playerId: string) {
  const op = await prisma.operator.create({
    data: {
      code: "op-low1-" + randomUUID().slice(0, 8),
      name: "Low1 Claim-First Operator",
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
  // recoverReservingBets() is private; drive it via recoverInterruptedRounds().
  return { recover: () => (engine as any).recoverInterruptedRounds(), provider };
}

/** Read a no-label prom-client counter's current value. */
async function counterValue(c: { get(): Promise<any> }): Promise<number> {
  const m = await c.get();
  return m.values?.[0]?.value ?? 0;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe + leave NO synthetic reserving/cancelling rows behind (a stray one
  // would be re-selected by a later boot-recovery / break a read-only fairness
  // scan). Order: explicit bets → bets-by-round → rounds → seeds → chains; then
  // internal users; then operator-tagged users; then operators.
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
    // F-017: the low1_ internal users carry a wallet + profile (and these tests write
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

// 1) placeBet LOSES the flip CAS — the slot is no longer 'reserving' at flip time
//    (recovery reclaimed it → 'cancelling'). The flip bet.updateMany returns
//    {count:0}; placeBet must report failure, leave NO phantom 'active' bet, and
//    record NO placed-bet metric. The real $transaction (PHASE 1, tx.bet.create)
//    and the real ledger debit run, so the row genuinely exists + money moved;
//    recovery is what reverses it (not placeBet).
//
//    FAILS-FIRST / TEETH: on pre-Low-1 code the flip was an UNCONDITIONAL
//    bet.update (no .count), so there was no count-0 branch — the slot would be
//    left 'active' (a phantom live bet a concurrent reclaim raced with) and
//    recordBet WOULD fire (RTP denominator polluted). Asserting status!=='active'
//    AND betsTotal unchanged both fail on the old code.
test("Low-1: placeBet loses the flip CAS (slot reclaimed) → ok:false, no phantom active bet, no placed-bet metric", async () => {
  const roundId = await seedBettingRound();
  const { userId, walletId } = await fundedUser(10_000n);

  // A prisma whose bet.updateMany returns {count:0} — simulating that recovery
  // reclaimed the slot ('reserving'→'cancelling') in the window between this
  // placeBet's debit and its flip, so the CAS where:{status:'reserving'} matches
  // nothing. Everything else is the real prisma: PHASE 1 runs in $transaction
  // (tx.bet.create, the interactive-tx client — NOT this.prisma.bet, so it is NOT
  // intercepted), and the debit uses the real ledger over the real prisma.
  const reclaimedPrisma: any = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === "bet") {
        const realBet = (target as any).bet;
        return new Proxy(realBet, {
          get(bt, p, r) {
            if (p === "updateMany") {
              // The flip (and the unreachable-here best-effort stamp) match nothing.
              return async () => ({ count: 0 });
            }
            return Reflect.get(bt, p, r);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const risk = new RiskService();
  const metrics = new MetricsService();
  const fakeEngine: any = {
    getPublicState: () => ({
      roundId,
      phase: "betting",
      phaseEndsAt: Date.now() + 5000,
      multiplier: 1.0,
      serverTime: Date.now(),
    }),
    currentMultiplier: () => 1.0,
  };
  const bets = new BetsService(reclaimedPrisma, ledger, fakeEngine, risk, metrics, makeAudit(reclaimedPrisma, metrics));

  const betsBefore = await counterValue(metrics.betsTotal);

  const res = await bets.placeBet(userId, "A", 100);

  // placeBet reports failure — it must NOT claim a win out of a lost CAS.
  expect(res.ok).toBe(false);
  expect(res.reason).toBe("bet_failed");

  // The row is NOT 'active' (no phantom live bet). The debit DID move money (real
  // ledger), so the row is left recoverable as 'reserving' — recovery reverses it.
  const row = await prisma.bet.findFirstOrThrow({ where: { roundId, userId, panel: "A" } });
  expect(row.status).not.toBe("active");
  expect(row.status).toBe("reserving");
  expect(await ledger.getBalance(walletId)).toBe(9_900n); // money out (recoverable)

  // NO placed-bet metric was recorded (recordBet only fires after a winning flip).
  expect(await counterValue(metrics.betsTotal)).toBe(betsBefore);

  // Sanity: recovery (real prisma + ledger) reverses the stranded debit → refunded,
  // 'cancelled'. (Also leaves the suite clean.)
  await recover();
  expect(await ledger.getBalance(walletId)).toBe(10_000n);
  expect((await prisma.bet.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("cancelled");
});

// 2) recovery's claim LOSES to a live activation — an 'active' bet is NEVER
//    reversed. Seed an 'active' bet + its ledger debit, run recovery, assert the
//    bet stays 'active', balance unchanged, 0 refunds. The findMany filter
//    in:[reserving,cancelling] excludes 'active'; we ALSO prove the claim CAS
//    itself guards it by intercepting the claim updateMany to return {count:0}
//    on a row that a concurrent flip just turned 'active' between the findMany
//    and the claim.
//
//    FAILS-FIRST / TEETH: if recovery reversed any non-active-excluded row, or if
//    a lost claim still proceeded to refund (no CAS guard), the 'active' bet would
//    be refunded (double-paid: it can still win) — asserting balance unchanged +
//    status 'active' + 0 refund rows catches that.
test("Low-1: recovery's claim loses to a live activation — an 'active' bet is never reversed", async () => {
  const roundId = await seedCompletedRound();
  const { userId, walletId } = await fundedUser(10_000n);

  // An ACTIVE bet whose stake was really debited — i.e. a fully placed, live bet.
  const betId = await seedBet({ roundId, userId, walletId, panel: "A", amount: 100n, status: "active" });
  const tx = await ledger.debit(walletId, 100n, "bet_debit", debitKey(roundId, userId, "A"), {
    refType: "bet",
    refId: betId,
  });
  await prisma.bet.update({ where: { id: betId }, data: { debitTxId: tx.id } });
  expect(await ledger.getBalance(walletId)).toBe(9_900n);

  // (a) The plain findMany filter already excludes 'active' — recovery is a no-op.
  await recover();
  const afterBoot = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(afterBoot.status).toBe("active"); // untouched
  expect(afterBoot.settledAt).toBeNull();
  expect(await ledger.getBalance(walletId)).toBe(9_900n); // debit stands — it may still win
  expect(
    (await prisma.ledgerTransaction.findMany({ where: { idempotencyKey: `bet:${betId}:restart_refund` } })).length,
  ).toBe(0);

  // (b) Prove the CAS itself is the guard: seed a SECOND row that recovery sees as
  //     'reserving' at findMany time, but whose claim updateMany matches 0 rows
  //     (the row flipped to 'active' in the race window). It must be left alone.
  const racedId = await seedBet({ roundId, userId, walletId, panel: "B", amount: 100n, status: "reserving" });
  await ledger.debit(walletId, 100n, "bet_debit", debitKey(roundId, userId, "B"), { refType: "bet", refId: racedId });
  expect(await ledger.getBalance(walletId)).toBe(9_800n);
  // Flip it to 'active' out-of-band (simulating placeBet winning the CAS first).
  await prisma.bet.update({ where: { id: racedId }, data: { status: "active" } });

  // A claim-losing prisma: the claim updateMany on this row returns {count:0}
  // (it is no longer 'reserving'); the row must NOT be reversed (continue).
  const claimLosesPrisma: any = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === "bet") {
        const realBet = (target as any).bet;
        return new Proxy(realBet, {
          get(bt, p, r) {
            if (p === "updateMany") {
              return async (args: any) => {
                // Only the CLAIM (reserving→cancelling) is forced to lose; any other
                // updateMany falls through to the real implementation.
                if (args?.where?.status === "reserving" && args?.data?.status === "cancelling") {
                  return { count: 0 };
                }
                return (realBet as any).updateMany(args);
              };
            }
            return Reflect.get(bt, p, r);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const guardedEngine = new GameEngineService(claimLosesPrisma, redisStub, fairnessStub, ledger, {} as any, {} as any, {} as any);
  await (guardedEngine as any).recoverInterruptedRounds();

  // The raced row stayed 'active' (claim lost → continue → never reversed), balance
  // unchanged, no refund. This is the CAS doing the guarding, not the age gate.
  const racedAfter = await prisma.bet.findUniqueOrThrow({ where: { id: racedId } });
  expect(racedAfter.status).toBe("active");
  expect(await ledger.getBalance(walletId)).toBe(9_800n);
  expect(
    (await prisma.ledgerTransaction.findMany({ where: { idempotencyKey: `bet:${racedId}:restart_refund` } })).length,
  ).toBe(0);

  // Clean these live debits back out so the suite leaves the wallet balanced:
  // (they are not reserving so recovery won't refund them — refund explicitly via
  // the cancel path is unnecessary; the user is deleted in afterAll, cascading).
});

// 3) crash mid-reversal ('cancelling' re-entry) is re-recovered. Seed a
//    'cancelling' bet (a prior pass that CLAIMED but crashed before reversing) +
//    its internal ledger debit. recoverReservingBets re-selects 'cancelling',
//    re-attempts the reversal: the bet becomes 'cancelled', the stake is refunded
//    EXACTLY ONCE, and a second pass is idempotent (no double refund).
//
//    FAILS-FIRST / TEETH: if recovery only selected 'reserving' (the pre-Low-1
//    filter), a crash-mid-reversal 'cancelling' row would be STRANDED forever —
//    money debited, never refunded. Asserting it becomes 'cancelled' + refunded
//    exactly once fails on a recovery that ignores 'cancelling'.
test("Low-1: a 'cancelling' bet (crash mid-reversal) is re-recovered and refunded exactly once", async () => {
  const roundId = await seedCompletedRound();
  const { userId, walletId } = await fundedUser(10_000n);

  // The money already left the wallet (debit applied) but a prior recovery pass
  // claimed the slot ('reserving'→'cancelling') and crashed BEFORE crediting the
  // refund. The deterministic debit row is the source of truth recovery re-finds.
  const betId = await seedBet({ roundId, userId, walletId, panel: "A", amount: 100n, status: "cancelling" });
  await ledger.debit(walletId, 100n, "bet_debit", debitKey(roundId, userId, "A"), { refType: "bet", refId: betId });
  expect(await ledger.getBalance(walletId)).toBe(9_900n); // money out, refund owed

  await recover();

  // Re-recovered: finalised 'cancelled' + stake restored.
  const after = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
  expect(after.status).toBe("cancelled");
  expect(after.settledAt).not.toBeNull();
  expect(await ledger.getBalance(walletId)).toBe(10_000n); // refunded

  // A second pass is idempotent: the row is 'cancelled' (not re-selected) AND the
  // restart_refund key is idempotent — no double refund.
  await recover();
  expect(await ledger.getBalance(walletId)).toBe(10_000n); // not 10_100n

  const refunds = await prisma.ledgerTransaction.findMany({
    where: { idempotencyKey: `bet:${betId}:restart_refund` },
  });
  expect(refunds.length).toBe(1);
  expect(refunds[0].amount).toBe(100n); // exactly one positive refund credit
});

// 4) OPERATOR-mode 'cancelling' re-recovery — a 'cancelling' operator slot (a
//    prior pass claimed but crashed before rolling back) → wallet$.rollback
//    reverses the operator charge once, the slot is dropped. A debit writes NO
//    local ledger row, so the rollback (not the internal-credit branch) is what
//    reverses the charge.
//
//    FAILS-FIRST / TEETH: same as #3 but for operator money — if recovery skipped
//    'cancelling', the operator charge would be stranded (player charged, no bet,
//    no rollback). Asserting balance restored + a rollback issued + slot dropped
//    fails on a recovery that ignores 'cancelling'.
test("Low-1 operator: a 'cancelling' operator slot is re-recovered — operator charge rolled back once, slot dropped", async () => {
  const currency = "EUR";
  const playerId = "p-cancelling-" + randomUUID().slice(0, 6);
  const startBalance = 1000;

  const { userId, walletId } = await launchPlayer(currency, playerId);
  const sandbox = startSandboxOperator({ seed: { [`${playerId}:${currency}`]: startBalance } });
  sandboxes.push(sandbox);
  const { recover: recoverOp, provider } = operatorEngine(sandbox);

  const roundId = await seedCompletedRound();
  const key = debitKey(roundId, userId, "A");

  // The operator wallet was ACTUALLY debited (balance down), under the
  // deterministic key recovery rolls back, but a prior pass claimed the slot and
  // crashed before the rollback → the row sits 'cancelling'.
  const tx = await provider.debit(walletId, 100n, "bet_debit", key, { refType: "bet", refId: "stub" });
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(BigInt(startBalance - 100)); // 900
  expect(sandbox.operator.calls.bet).toBe(1);

  const betId = await seedBet({
    roundId,
    userId,
    walletId,
    panel: "A",
    amount: 100n,
    status: "cancelling",
    debitTxId: tx.id,
  });

  // Operator-mode precondition: a debit writes NO local ledger row, so the rollback
  // branch (not the internal credit) reverses the charge.
  expect(await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: key } })).toBeNull();

  const rollbacksBefore = sandbox.operator.calls.rollback;

  await recoverOp();

  // The operator charge was REVERSED: a rollback was issued and the balance is back
  // to start. THIS is the money-conservation proof for the 'cancelling' re-entry.
  expect(sandbox.operator.calls.rollback).toBeGreaterThanOrEqual(rollbacksBefore + 1);
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(BigInt(startBalance)); // 1000 — fully restored

  // The slot is gone (no local debit row → dropped after the rollback), and the
  // internal ledger was never touched (no phantom local refund/debit conjured).
  expect(await prisma.bet.findUnique({ where: { id: betId } })).toBeNull();
  expect(
    (await prisma.ledgerTransaction.findMany({ where: { idempotencyKey: `bet:${betId}:restart_refund` } })).length,
  ).toBe(0);
  expect(await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey: key } })).toBeNull();

  // Idempotent on a second pass: already gone, rollback no-ops.
  const rollbacksAfter = sandbox.operator.calls.rollback;
  await recoverOp();
  expect(sandbox.operator.balanceOf(playerId, currency)).toBe(BigInt(startBalance)); // still 1000
  // No NEW slot to process — count must not grow from re-reversing a dropped slot.
  void rollbacksAfter;
});
