import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../src/prisma/prisma.service";
import { LedgerService } from "../../src/wallet/ledger.service";
import { RiskService } from "../../src/game/risk.service";
import { MetricsService } from "../../src/metrics/metrics.service";
import { BetsService, type Panel } from "../../src/game/bets.service";
import { makeAudit } from "../helpers/audit";

/**
 * Phase 4.5c.1 — CONCURRENT LEADER-OVERLAP (the soft race) regression. The money-path-auditor
 * asked for this to clear the multi-node cutover gate "by integration" rather than by argument:
 *
 *   "Two BetsService instances sharing the real Prisma, same active bet, fire
 *    evaluateAutoCashouts(liveMult) and evaluateAutoCashouts(crashPoint) concurrently;
 *    assert exactly one payout_credit row + correct final status."
 *
 * The scenario: a leader dies mid-round. For ~1 heartbeat the STALE ex-leader's in-flight
 * onTick (driving evaluateAutoCashouts at the live multiplier) is still in flight while the
 * SURVIVOR resumes the round and runs its honor-pay (evaluateAutoCashouts at the crashPoint).
 * cashOut/onTick are isLeader()-gated (a fast boolean), NOT fence-gated — so BOTH can reach
 * cashOut for the SAME active bet at the same time. The ONLY thing keeping the win exactly-once
 * and never-above-crash across nodes is the authoritative bet.round re-read (4.5c.1) + the
 * `status='active'` CAS claim in cashOut (the documented "fence-substitution" invariant at
 * bets.service.ts:378). This test is its executable proof.
 *
 * Faithfulness to the auditor's ask — the money path is REAL, not mocked:
 *   - ONE shared real Prisma + ONE shared real internal LedgerService as the WalletProvider for
 *     BOTH BetsService instances (so both flow through the same ledger rows + the same
 *     `bet:{id}:payout` idempotency key — the global dedup that must hold across "nodes").
 *   - Two DISTINCT engine stubs (instance A = stale ex-leader, instance B = survivor), each
 *     returning getPublicState() = phase 'running' for the SAME DB round, mimicking two nodes
 *     that both still see the round live. The 4.5c.1 gate reads bet.round from the DB, so both
 *     are anchored to the same authoritative round row.
 *   - The two evaluators are fired with Promise.all (genuinely concurrent), each at a different
 *     multiplier (live vs crashPoint), both BELOW crash so neither is gate-rejected on multiplier.
 *
 * Cleanup is tracked + FK-safe (bets → rounds → users[cascade wallets+ledger] → seeds → chains),
 * synthetic epochs >9e6 (never collide with real/dev), and we quiesce stray OPEN rounds so a
 * real/dev round can't perturb anything — matching test/ha/failover-resume.test.ts.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();

// ---- per-node engine stub: the ONLY engine surface cashOut()/evaluateAutoCashouts() touch is
//      getPublicState() (phase gate + roundId) and currentMultiplier() (live mult for a manual
//      cash-out; auto-cashout passes the target explicitly so it's unused on this path). A plain
//      stub returning phase 'running' for `roundId` faithfully mimics a node that still sees the
//      round live. Two of these = two independent "nodes" over ONE shared DB + ledger.
function makeEngineStub(roundId: string, liveMult: number): any {
  return {
    getPublicState: () => ({
      roundId,
      phase: "running",
      phaseEndsAt: Date.now() + 60_000,
      multiplier: liveMult,
      serverTime: Date.now(),
    }),
    currentMultiplier: () => liveMult,
  };
}

/** A live BetsService bound to ONE node's engine stub but the SHARED real Prisma + ledger. */
function makeBets(engineStub: any): BetsService {
  return new BetsService(prisma, ledger as any, engineStub, risk, metrics, makeAudit(prisma, metrics));
}

// ---- cleanup tracking (FK-safe) ----
const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];

/** A fresh fairness chain + one usable seed. Synthetic epoch (>9e6) so it never collides with
 *  real/dev epochs; status 'exhausted' so fairness scans skip it. */
async function makeSeed(): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 9_000_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "cl-" + randomUUID(),
      length: 2,
      salt: "cl-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "cl-" + randomUUID(), seed: "cl-seed-" + randomUUID() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  return seed.id;
}

/** Persist a `running` round with a (server-only) crashPoint — the in-flight round both nodes
 *  still see live. */
async function makeRunningRound(crashPoint: number): Promise<string> {
  const round = await prisma.round.create({
    data: {
      seedId: await makeSeed(),
      nonce: 1n,
      crashPoint,
      status: "running",
      bettingOpensAt: new Date(),
      startedAt: new Date(Date.now() - 200),
      phaseEndsAt: new Date(Date.now() + 60_000),
    },
  });
  createdRoundIds.push(round.id);
  return round.id;
}

/** A funded DEMO wallet + profile. `originalBalance` is post-debit (the open bet already charged
 *  the stake), so a single payout lands it at original + payout. */
async function makeWallet(originalBalance: bigint): Promise<{ userId: string; walletId: string }> {
  const id = randomUUID();
  const u = await prisma.user.create({
    data: {
      id,
      username: "cl_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance: originalBalance } },
      profile: { create: { displayName: "cl" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(id);
  return { userId: id, walletId: u.wallets[0].id };
}

/** Insert an ACTIVE bet (already debited) directly — the in-flight open bet both nodes will race. */
async function makeActiveBet(
  roundId: string,
  w: { userId: string; walletId: string },
  panel: Panel,
  amount: bigint,
  autoCashout: number,
): Promise<string> {
  const betId = randomUUID();
  await prisma.bet.create({
    data: {
      id: betId,
      roundId,
      userId: w.userId,
      walletId: w.walletId,
      panel,
      amount,
      autoCashout,
      status: "active",
      currency: "DEMO",
    },
  });
  return betId;
}

/** Clear any pre-existing OPEN round so a stray real/dev round can't perturb the engine stubs. */
async function quiesceOpenRounds() {
  await prisma.round.updateMany({
    where: { status: { in: ["waiting", "betting", "running", "crashed", "settling"] } },
    data: { status: "completed" },
  });
}

const payoutKey = (betId: string) => `bet:${betId}:payout`;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe purge of THIS run's synthetic rows. Best-effort; never fail the suite on cleanup.
  try {
    if (createdRoundIds.length) await prisma.bet.deleteMany({ where: { roundId: { in: createdRoundIds } } });
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdUserIds.length) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

describe("Phase 4.5c.1 concurrent leader-overlap cash-out (fence-substitution proof)", () => {
  // ── Race 1: the soft leader-overlap — stale ex-leader's onTick vs survivor's resume honor ──
  test("stale-leader auto-cashout (live mult) races survivor honor-pay (crashPoint) on the SAME active bet → paid EXACTLY ONCE, at the auto TARGET, never above crash", async () => {
    await quiesceOpenRounds();
    const crashPoint = 3.0; // server-only; both nodes still see the round running
    const target = 2.0; // auto-cashout target, BELOW crash → due for both evaluators
    const stake = 1000n;
    const originalBalance = 9000n; // post-debit (the 1000 stake already charged)

    const roundId = await makeRunningRound(crashPoint);
    const w = await makeWallet(originalBalance);
    const betId = await makeActiveBet(roundId, w, "A", stake, target);

    const balBefore = await ledger.getBalance(w.walletId);
    expect(balBefore).toBe(originalBalance);

    // Two independent "nodes" over the SAME shared Prisma + ledger:
    //   A = STALE EX-LEADER: its in-flight onTick drives auto-cashout at the LIVE multiplier
    //       (2.5 — already past the 2.0 target, below the 3.0 crash).
    //   B = SURVIVOR: resumes the round and honor-pays at the crashPoint (3.0). The target
    //       (2.0) is still < crash, so cashOut(...,2.0) passes the authoritative gate.
    const liveMult = 2.5;
    const A = makeBets(makeEngineStub(roundId, liveMult));
    const B = makeBets(makeEngineStub(roundId, crashPoint));

    // GENUINELY CONCURRENT: both evaluators in flight at once (Promise.all). Each independently
    // reads the active bet, then races cashOut → the bet-status CAS + the payout idempotency key
    // are the ONLY arbiters of exactly-once.
    const [aRes, bRes] = await Promise.all([
      A.evaluateAutoCashouts(liveMult), // stale ex-leader tick
      B.evaluateAutoCashouts(crashPoint), // survivor honor-pay
    ]);

    // Across BOTH evaluators, the bet was reported paid by exactly ONE (the CAS winner); the
    // loser's evaluateAutoCashouts returns it as non-ok and drops it (so results stay empty).
    const okResults = [...aRes, ...bRes].filter((r) => r.ok && r.payout === Number(stake) * target);
    expect(okResults.length).toBe(1);

    // ── THE core money invariant: exactly ONE payout_credit ledger row for this bet's key. ──
    const payoutRows = await prisma.ledgerTransaction.count({
      where: { walletId: w.walletId, type: "payout_credit", idempotencyKey: payoutKey(betId) },
    });
    expect(payoutRows).toBe(1); // <-- removing the CAS or the shared idempotency key DOUBLES this

    // No stray credit under any OTHER key either (total payout_credits for the wallet == 1).
    expect(await prisma.ledgerTransaction.count({ where: { walletId: w.walletId, type: "payout_credit" } })).toBe(1);

    // Final bet status: cashed_out exactly once, with a SINGLE payout/cashoutMult at the TARGET.
    const finalBet = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(finalBet.status).toBe("cashed_out");
    expect(finalBet.payout).toBe(stake * BigInt(target)); // 1000 * 2 = 2000
    expect(Number(finalBet.cashoutMult)).toBe(target); // paid at the auto TARGET 2.0 …
    expect(Number(finalBet.cashoutMult)).not.toBe(liveMult); // … NOT the stale leader's live 2.5
    expect(Number(finalBet.cashoutMult)).toBeLessThan(crashPoint); // and strictly below crash

    // Wallet credited by exactly ONE payout (no double-credit from the overlap).
    const balAfter = await ledger.getBalance(w.walletId);
    expect(balAfter).toBe(originalBalance + stake * BigInt(target)); // 9000 + 2000 = 11000
    expect(balAfter - balBefore).toBe(stake * BigInt(target)); // exactly one payout's worth

    // Leaderboard/profile loot incremented ONCE (not twice). total_loot == the single payout.
    const profile = await prisma.profile.findUniqueOrThrow({ where: { userId: w.userId } });
    expect(profile.totalLoot).toBe(stake * BigInt(target)); // 2000, applied once
    expect(Number(profile.biggestMultiplier)).toBe(target); // recorded the target, once

    // Idempotency belt: re-running EITHER evaluator now pays nobody (bet is no longer active).
    const again = await Promise.all([A.evaluateAutoCashouts(liveMult), B.evaluateAutoCashouts(crashPoint)]);
    expect(again.flat().length).toBe(0);
    expect(await prisma.ledgerTransaction.count({ where: { walletId: w.walletId, type: "payout_credit" } })).toBe(1);
  });

  // ── Race 1 (above-crash direction): the gate still rejects >= crash even under the overlap ──
  test("survivor honor-pay at crashPoint for a bet whose TARGET == crashPoint → busts (0 payout): the 4.5c.1 gate rejects >= crash even under the race", async () => {
    await quiesceOpenRounds();
    const crashPoint = 2.0;
    const target = 2.0; // target == crash → cashOut(...,2.0) hits `mult >= crashPoint` → rejected
    const stake = 1000n;
    const originalBalance = 9000n;

    const roundId = await makeRunningRound(crashPoint);
    const w = await makeWallet(originalBalance);
    const betId = await makeActiveBet(roundId, w, "A", stake, target);

    // Both a stale-leader live-mult evaluator AND the survivor honor evaluator at crash: the
    // autoCashout (2.0) makes the bet "due" at multiplier 2.0, so cashOut is REACHED — and then
    // the authoritative gate (mult 2.0 >= crashPoint 2.0) must reject it. No payout, ever.
    const A = makeBets(makeEngineStub(roundId, crashPoint));
    const B = makeBets(makeEngineStub(roundId, crashPoint));
    const [aRes, bRes] = await Promise.all([
      A.evaluateAutoCashouts(crashPoint),
      B.evaluateAutoCashouts(crashPoint),
    ]);

    // Neither evaluator paid (the gate rejected both before any claim/credit).
    expect([...aRes, ...bRes].length).toBe(0);
    expect(await prisma.ledgerTransaction.count({ where: { walletId: w.walletId, type: "payout_credit" } })).toBe(0);

    // The bet is still 'active' (gate rejected, never claimed) — the crash path will bust it.
    // Drive settleRound (what enterSettling does on crash) and assert it busts with 0 payout.
    let bet = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(bet.status).toBe("active");
    expect(bet.payout).toBe(0n);

    await A.settleRound(roundId); // crash → bust the still-active loser
    bet = await prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    expect(bet.status).toBe("busted");
    expect(bet.payout).toBe(0n);

    // Balance unchanged (debit kept, no payout), and STILL no payout_credit row.
    expect(await ledger.getBalance(w.walletId)).toBe(originalBalance);
    expect(await prisma.ledgerTransaction.count({ where: { walletId: w.walletId, type: "payout_credit" } })).toBe(0);
  });
});
