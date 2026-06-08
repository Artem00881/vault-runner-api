import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { LedgerService } from "../src/wallet/ledger.service";
import { RiskService } from "../src/game/risk.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { BetsService } from "../src/game/bets.service";
import { WAGERED_STATUSES } from "../src/common/bet-status";
import { makeAudit } from "./helpers/audit";

/**
 * F-018 (audit M4) — the money-invariant / reconcile gate as a REAL, deterministic
 * CI test, independent of the dirty shared dev DB.
 *
 * scripts/reconcile-check.ts is a standalone read-only script that asserts the 6
 * conservation invariants over the WHOLE ledger. Run against the shared dev DB it is
 * non-deterministic (other suites leave half-states / backlog) — so it can't be a
 * trustworthy gate by itself. This test instead BUILDS a fresh, fully-scoped book of
 * its own (a cashed-out win, a bust, a busted-then-void, a cashed-out-then-void, an
 * operator-tagged payout_credit) and replicates the SCRIPT'S EXACT invariant SQL,
 * scoped to the ids it created, then asserts every invariant is `ok` (0 discrepancies).
 *
 * Because the scope is a clean isolated book, the gate is deterministic on the
 * ephemeral CI Postgres (empty + migrated) AND on the dirty local dev DB — the other
 * rows simply aren't in scope. The invariant LOGIC is identical to the script's
 * (same joins / same WAGERED_STATUSES from common/bet-status / same balance LATERAL),
 * so a regression that broke the money definition would fail HERE too.
 *
 * It ALSO carries the standing DB guard against a mis-typed void leg (the preferred,
 * non-breaking alternative to a CHECK constraint): after a void, NO payout_credit /
 * refund ledger row may exist with ref_type IS DISTINCT FROM 'bet' for the scoped
 * book — so a future void leg that forgot refType:"bet" (and would silently fall out
 * of the reconcile join) fails the suite.
 *
 * Wiring mirrors operator-void.test.ts: a real PrismaService + LedgerService +
 * RiskService + MetricsService + a fake engine; rows tracked + torn down FK-safely.
 */

const prisma = new PrismaService();
const ledger = new LedgerService(prisma);
const risk = new RiskService();
const metrics = new MetricsService();
const fakeEngine: any = {
  getPublicState: () => ({ roundId: "", phase: "betting", phaseEndsAt: Date.now() + 60_000, multiplier: 1, serverTime: Date.now() }),
  currentMultiplier: () => 1,
};
const bets = new BetsService(prisma, ledger, fakeEngine, risk, metrics, makeAudit(prisma, metrics));

const createdRoundIds: string[] = [];
const createdSeedIds: string[] = [];
const createdChainIds: string[] = [];
const createdUserIds: string[] = [];
const createdBetIds: string[] = [];

const debitKey = (roundId: string, userId: string, panel: string) => `bet:${roundId}:${userId}:${panel}:debit`;
const payoutKey = (betId: string) => `bet:${betId}:payout`;

/** Synthetic epoch far above any live epoch — a read-only fairness scan never touches it. */
async function makeRound(status = "crashed"): Promise<string> {
  const chain = await prisma.fairnessChain.create({
    data: {
      epoch: 7_800_000 + Math.floor(Math.random() * 1_000_000),
      commitHash: "recon-" + randomUUID(),
      length: 2,
      salt: "recon-" + randomUUID(),
      status: "exhausted",
    },
  });
  const seed = await prisma.fairnessSeed.create({
    data: { chainId: chain.id, chainIndex: 1, seedHash: "recon-" + randomUUID() },
  });
  const round = await prisma.round.create({
    data: { seedId: seed.id, nonce: 1n, crashPoint: 5.0, status, bettingOpensAt: new Date() },
  });
  createdChainIds.push(chain.id);
  createdSeedIds.push(seed.id);
  createdRoundIds.push(round.id);
  return round.id;
}

async function makePlayer(balance: bigint, operatorId: string | null = null) {
  const id = randomUUID();
  const user = await prisma.user.create({
    data: {
      id,
      username: "recon_" + id.slice(0, 12),
      wallets: { create: { currency: "DEMO", balance } },
      profile: { create: { displayName: "r" } },
    },
    include: { wallets: true },
  });
  createdUserIds.push(user.id);
  return { userId: user.id, walletId: user.wallets[0].id, operatorId };
}

/** Seed a SETTLED bet WITH its real ledger rows exactly as the live money path leaves
 *  it: a `bet_debit` under the deterministic debit key + (for a win) a `payout_credit`
 *  under bet:{id}:payout. The payout ledger row is INTERNAL-only (operatorId null) — an
 *  operator-mode win keeps its book at the operator (no ledger row), which we model by
 *  setting payoutTxId without an internal payout_credit. */
async function settledBet(opts: {
  walletId: string;
  userId: string;
  status: "busted" | "cashed_out";
  stake: bigint;
  payout?: bigint;
  operatorId?: string | null;
  panel?: "A" | "B";
}): Promise<{ betId: string; roundId: string }> {
  const roundId = await makeRound();
  const panel = opts.panel ?? "A";
  const betId = randomUUID();
  const operatorId = opts.operatorId ?? null;

  if (operatorId === null) {
    // INTERNAL book: real ledger rows (this is what reconcile-check audits).
    await ledger.debit(opts.walletId, opts.stake, "bet_debit", debitKey(roundId, opts.userId, panel), {
      refType: "bet",
      refId: betId,
    });
  }
  const payout = opts.payout ?? 0n;
  let payoutTxId: string | null = null;
  if (opts.status === "cashed_out" && payout > 0n) {
    if (operatorId === null) {
      const tx = await ledger.credit(opts.walletId, payout, "payout_credit", payoutKey(betId), { refType: "bet", refId: betId });
      payoutTxId = tx.id;
    } else {
      payoutTxId = "op-tx-" + randomUUID(); // operator paid it on its own book
    }
  }

  await prisma.bet.create({
    data: {
      id: betId,
      roundId,
      userId: opts.userId,
      walletId: opts.walletId,
      panel,
      amount: opts.stake,
      status: opts.status,
      payout,
      operatorId,
      currency: "DEMO",
      ...(payoutTxId ? { payoutTxId, cashoutMult: 2.5 } : {}),
      settledAt: new Date(),
    },
  });
  createdBetIds.push(betId);
  return { betId, roundId };
}

// ── Scoped invariant checks: the EXACT queries scripts/reconcile-check.ts runs, but
//    filtered to OUR wallet/bet ids so the shared dev DB's rows are out of scope. Each
//    returns { ok, detail } shaped like the script's Check, so a failure is legible.
type Check = { name: string; ok: boolean; detail: string };
type Agg = { s: bigint | null };

async function scopedChecks(walletIds: string[], betIds: string[]): Promise<Check[]> {
  const checks: Check[] = [];
  const sumLedger = async (type: string): Promise<bigint> =>
    (
      await prisma.$queryRaw<Agg[]>`
        SELECT COALESCE(SUM(l.amount), 0)::bigint AS s
        FROM ledger_transactions l JOIN game_bets b ON b.id = l.ref_id
        WHERE l.type = ${type} AND l.ref_type = 'bet' AND b.operator_id IS NULL
          AND l.wallet_id = ANY(${walletIds}::uuid[])`
    )[0].s ?? 0n;

  const liveDebit = await sumLedger("bet_debit"); // negative
  const liveRefund = await sumLedger("refund"); // positive (incl. void/cancel refunds)
  const livePayout = await sumLedger("payout_credit"); // net (incl. negative void reclaims)

  // INVARIANT 1a — debit conservation: |Σ bet_debit| − Σ refund == Σ stake(held).
  const heldStakes =
    (await prisma.bet.aggregate({
      where: { walletId: { in: walletIds }, operatorId: null, status: { in: [...WAGERED_STATUSES] } },
      _sum: { amount: true },
    }))._sum.amount ?? 0n;
  const debitNetOfRefunds = -liveDebit - liveRefund;
  checks.push({
    name: "1a. debit conservation (|Σ bet_debit| − Σ refund == Σ stake held)",
    ok: debitNetOfRefunds === heldStakes,
    detail: `|debit|=${-liveDebit} − refund=${liveRefund} => ${debitNetOfRefunds} vs heldStakes=${heldStakes}`,
  });

  // INVARIANT 1b — payout conservation: Σ payout_credit == Σ payout over PAID wins.
  const paidPayouts =
    (await prisma.bet.aggregate({
      where: { walletId: { in: walletIds }, operatorId: null, status: "cashed_out" },
      _sum: { payout: true },
    }))._sum.payout ?? 0n;
  checks.push({
    name: "1b. payout conservation (Σ payout_credit == Σ payout of paid wins)",
    ok: livePayout === paidPayouts,
    detail: `payout_credit=${livePayout} vs Σ payout(cashed_out)=${paidPayouts}`,
  });

  // INVARIANT 2 — ledger ↔ balance: latest balanceAfter == wallet.balance.
  const balRows = await prisma.$queryRaw<{ wallet_id: string; balance: bigint; balance_after: bigint }[]>`
    SELECT w.id AS wallet_id, w.balance AS balance, lt.balance_after AS balance_after
    FROM wallets w
    JOIN LATERAL (
      SELECT balance_after FROM ledger_transactions l
      WHERE l.wallet_id = w.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1
    ) lt ON true
    WHERE w.id = ANY(${walletIds}::uuid[])`;
  const balMismatches = balRows.filter((r) => BigInt(r.balance) !== BigInt(r.balance_after));
  checks.push({
    name: "2. ledger ↔ balance (latest balanceAfter == wallet.balance)",
    ok: balMismatches.length === 0,
    detail: `${balRows.length} wallet(s) checked; ${balMismatches.length} mismatch(es)`,
  });

  // INVARIANT 3 — payout linkage: every cashed_out (internal) win has a payout_credit
  // row keyed bet:{id}:payout AND a payoutTxId.
  const cashedOut = await prisma.bet.findMany({
    where: { id: { in: betIds }, operatorId: null, status: "cashed_out" },
    select: { id: true, payout: true, payoutTxId: true },
  });
  const payoutKeys = new Set(
    (
      await prisma.ledgerTransaction.findMany({
        where: { type: "payout_credit", walletId: { in: walletIds } },
        select: { idempotencyKey: true },
      })
    ).map((r) => r.idempotencyKey),
  );
  const missingLedger = cashedOut.filter((b) => b.payout > 0n && !payoutKeys.has(`bet:${b.id}:payout`));
  const missingTxId = cashedOut.filter((b) => !b.payoutTxId);
  checks.push({
    name: "3. payout linkage (cashed_out ⇒ payout_credit row + payoutTxId)",
    ok: missingLedger.length === 0 && missingTxId.length === 0,
    detail: `${cashedOut.length} cashed_out; ${missingLedger.length} missing ledger, ${missingTxId.length} missing txId`,
  });

  // INVARIANT 4 — busted purity: no busted bet has a payout_credit row.
  const busted = await prisma.bet.findMany({ where: { id: { in: betIds }, operatorId: null, status: "busted" }, select: { id: true } });
  const paidBusted = busted.filter((b) => payoutKeys.has(`bet:${b.id}:payout`));
  checks.push({
    name: "4. busted purity (no busted bet was paid)",
    ok: paidBusted.length === 0,
    detail: `${busted.length} busted; ${paidBusted.length} had a payout row`,
  });

  // INVARIANT 5 — backlog drained: reserving|cancelling|voiding == 0 AND payout_pending == 0.
  const backlog = await prisma.bet.count({
    where: { id: { in: betIds }, status: { in: ["reserving", "cancelling", "voiding", "payout_pending"] } },
  });
  checks.push({
    name: "5. backlog drained (no reserving|cancelling|voiding|payout_pending in scope)",
    ok: backlog === 0,
    detail: `backlog=${backlog}`,
  });

  return checks;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // FK-safe: bet → ledger → profile → wallet → user; then round → seed → chain.
  try {
    if (createdBetIds.length) await prisma.bet.deleteMany({ where: { id: { in: createdBetIds } } });
    if (createdUserIds.length) {
      await prisma.bet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.ledgerTransaction.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.profile.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    if (createdRoundIds.length) await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
    if (createdSeedIds.length) await prisma.fairnessSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    if (createdChainIds.length) await prisma.fairnessChain.deleteMany({ where: { id: { in: createdChainIds } } });
  } catch {
    /* never fail the suite on cleanup */
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F-018 reconcile-check invariants over a fresh, fully-scoped book", () => {
  test("all 6 invariants PASS (cashout, bust, void(refund), void(reclaim+refund), operator payout)", async () => {
    const START = 100_000n;
    const { userId, walletId } = await makePlayer(START);

    // A) a cashed-out WIN that stays paid (house pays out).
    const win = await settledBet({ walletId, userId, status: "cashed_out", stake: 1000n, payout: 2500n });
    // B) a BUST the house keeps.
    const bust = await settledBet({ walletId, userId, status: "busted", stake: 1500n });
    // C) a busted bet we then VOID (refund only).
    const voidBust = await settledBet({ walletId, userId, status: "busted", stake: 2000n });
    // D) a cashed-out bet we then VOID (reclaim payout FIRST + refund stake).
    const voidWin = await settledBet({ walletId, userId, status: "cashed_out", stake: 3000n, payout: 9000n });

    await bets.voidBet(null as any, voidBust.betId);
    await bets.voidBet(null as any, voidWin.betId);

    // E) an OPERATOR-tagged win (paid on the operator's book — NO internal ledger row).
    //    Proves the scoped invariants are honest in a MIXED book: it's out-of-scope for
    //    the internal ledger-conservation joins (operator_id IS NULL filter excludes it),
    //    exactly like the script reports operator bets as out-of-scope-here.
    const opId = randomUUID();
    const opPlayer = await makePlayer(0n, opId);
    const opWin = await settledBet({
      walletId: opPlayer.walletId, userId: opPlayer.userId, status: "cashed_out",
      stake: 5000n, payout: 12000n, operatorId: opId,
    });

    const walletIds = [walletId, opPlayer.walletId];
    const betIds = [win.betId, bust.betId, voidBust.betId, voidWin.betId, opWin.betId];
    const checks = await scopedChecks(walletIds, betIds);

    const failed = checks.filter((c) => !c.ok);
    if (failed.length) {
      // Surface a legible failure exactly like the script's report.
      for (const c of failed) console.error(`  [FAIL] ${c.name}\n         ${c.detail}`);
    }
    expect(failed.map((c) => c.name)).toEqual([]); // ALL invariants ok → 0 discrepancies

    // Cross-check the headline money figure for the internal wallet: it keeps only the
    // un-voided bust stake (1500). The win nets +1500, both voids net to 0.
    // START + win(+1500) − bust(1500) + voidBust(0) + voidWin(0) = START − 1500 + 1500 = START.
    // win: −1000 +2500 = +1500; bust: −1500; voids net 0  ⇒  100000 +1500 −1500 = 100000.
    expect(await ledger.getBalance(walletId)).toBe(START + 1500n - 1500n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STANDING DB GUARD against a mis-typed void leg (preferred over a CHECK constraint,
// which could reject valid future rows). A void's refund + payout-reclaim legs MUST
// carry refType:"bet" so they land in the reconcile join. If a future change posts a
// void leg WITHOUT refType:"bet" (ref_type NULL or anything else), the reconcile sums
// would silently drop it (money would appear to vanish) — this fails the suite first.
describe("F-018 standing guard: every void payout_credit/refund leg is ref_type='bet'", () => {
  test("after voids, NO payout_credit/refund ledger row has ref_type IS DISTINCT FROM 'bet' (scoped)", async () => {
    const { userId, walletId } = await makePlayer(50_000n);
    // One bust→void (refund leg) + one win→void (reclaim + refund legs).
    const vb = await settledBet({ walletId, userId, status: "busted", stake: 1000n });
    const vw = await settledBet({ walletId, userId, status: "cashed_out", stake: 2000n, payout: 5000n });
    await bets.voidBet(null as any, vb.betId);
    await bets.voidBet(null as any, vw.betId);

    // Every refund / payout_credit row for THIS wallet must be ref_type='bet'.
    const offenders = await prisma.$queryRaw<{ idempotency_key: string; type: string; ref_type: string | null }[]>`
      SELECT idempotency_key, type, ref_type
      FROM ledger_transactions
      WHERE wallet_id = ${walletId}::uuid
        AND type IN ('refund', 'payout_credit')
        AND ref_type IS DISTINCT FROM 'bet'`;
    expect(offenders).toEqual([]); // a future mis-typed void leg fails HERE

    // Belt-and-braces: the void legs we expect ARE present and correctly typed.
    const legs = await prisma.ledgerTransaction.findMany({
      where: {
        walletId,
        idempotencyKey: {
          in: [
            `bet:${vb.betId}:void_refund`,
            `bet:${vw.betId}:void_refund`,
            `bet:${vw.betId}:void_reclaim`,
          ],
        },
      },
      orderBy: { idempotencyKey: "asc" },
    });
    expect(legs.length).toBe(3);
    for (const l of legs) expect(l.refType).toBe("bet");
    // refund legs are positive `refund`; the reclaim is a NEGATIVE payout_credit.
    const reclaim = legs.find((l) => l.idempotencyKey === `bet:${vw.betId}:void_reclaim`)!;
    expect(reclaim.type).toBe("payout_credit");
    expect(reclaim.amount).toBe(-5000n);
  });
});
