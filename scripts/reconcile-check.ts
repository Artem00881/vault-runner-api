/**
 * Ledger-vs-bets reconciliation check (Phase 4.4 — acceptance gate for SLA #4:
 * "0 reconciliation discrepancies / 1e6 rounds").
 *
 * Standalone read-only query (no NestJS app, like scripts/simulate-rtp.ts). Run it
 * AFTER a soak (the long failure-injected 1e6-round run itself is driven in 4.5;
 * this is the assertion you run against the resulting DB). Exits non-zero if any
 * invariant fails so it can gate a CI/soak pipeline.
 *
 * INVARIANTS (all must hold):
 *  1. MONEY IDENTITY  — Σ debited == Σ credited + Σ kept.
 *       Σ debited  = Σ |bet_debit|            (ledger; stake that actually moved)
 *       Σ credited = Σ payout_credit + Σ refund (ledger; money returned to players)
 *       Σ kept     = Σ stake over `busted` bets  (house keeps a lost stake)
 *     Rearranged check: (Σ debit − Σ credit − Σ refund) == Σ stake(busted).
 *  2. LEDGER ↔ BALANCE — for every wallet, the latest row's balanceAfter == the
 *     wallet's current balance (the running ledger reconstructs the balance).
 *  3. PAYOUT LINKAGE  — every `cashed_out` bet has (a) payout > 0 ⇒ a payout_credit
 *     ledger row keyed `bet:{id}:payout`, and (b) a non-null payoutTxId. A
 *     `cashed_out` win with no payout ledger row is money owed-and-lost.
 *  4. BUSTED PURITY   — no `busted` bet has a payout_credit row (we never pay a bust).
 *  5. BACKLOG DRAINED — reserving|cancelling == 0 AND payout_pending == 0 (the
 *     `reserving`/`payout_pending` gauges must return to 0 after the soak settles).
 *  6. ROLLBACK OUTBOX DRAINED — wallet_rollbacks pending == 0 (the operator-mode
 *     rollback outbox, M1/F-027: a failed-emit rollback the reserving sweep re-issues
 *     must confirm and drain to 0 after the soak settles).
 *
 * NOTE on payout_pending (inv 5) and the rollback outbox (inv 6): both are OWED,
 * self-healing backlogs the periodic sweeps drain. A clean soak ends with both at 0.
 * If you run this MID-soak with operator faults still in flight, expect a non-zero
 * count — that's the sweep's backlog, not a discrepancy; let it drain first.
 *
 * SCOPE (mode-aware): the internal ledger (`ledger_transactions`) is written ONLY
 * for internal/guest play (`operatorId IS NULL`). Operator-mode bets route to the
 * operator wallet, which keeps its OWN book and writes NO ledger rows — so the
 * ledger-conservation invariants (1a/1b/3/4) are scoped to `operatorId IS NULL`
 * and validate the INTERNAL book only. Operator-side money reconciliation (against
 * the operator statement) is the Phase 4.5 operator-soak's job. Invariants 2
 * (ledger↔balance, only wallets with ledger activity) and 5 (backlog) are
 * mode-agnostic. This makes the gate honest in internal, operator, and mixed books
 * (no false FAIL in operator mode, no false PASS — operator bets are reported as
 * out-of-scope-here, not silently counted as reconciled).
 *
 * Run:
 *   DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
 *     bun scripts/reconcile-check.ts
 */
import { PrismaClient } from "@prisma/client";
import { WAGERED_STATUSES } from "../src/common/bet-status";

const prisma = new PrismaClient();

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  warn?: boolean; // a non-money advisory (e.g. cosmetic backfill on legacy rows) — printed but doesn't fail the run
}

async function main() {
  const checks: Check[] = [];

  // Operator-mode bets keep their book on the operator side (NO ledger rows), so the
  // ledger-conservation invariants below are scoped to the internal book; operator bets
  // are reported as out-of-scope-here (validated against the operator statement in the
  // Phase 4.5 operator soak), never silently counted as reconciled.
  const operatorBets = await prisma.bet.count({ where: { operatorId: { not: null } } });

  // --- 1. MONEY IDENTITY: Σ debit − Σ credit − Σ refund == Σ stake(busted) ---
  // Ledger sums by type. amount is signed (bet_debit negative; credits positive).
  const byType = await prisma.ledgerTransaction.groupBy({
    by: ["type"],
    _sum: { amount: true },
  });
  const sumOf = (t: string) => byType.find((r) => r.type === t)?._sum.amount ?? 0n;
  const debit = sumOf("bet_debit"); // negative (money OUT of player wallets)
  const payout = sumOf("payout_credit"); // positive
  const refund = sumOf("refund"); // positive
  const deposit = sumOf("deposit"); // positive (guest funding / top-ups)
  const adjustment = sumOf("adjustment"); // signed (manual)

  // IMPORTANT — scope to bets that STILL EXIST. The engine legitimately DELETES bet
  // rows (placeBet-failure release; reserving-recovery of a no-debit slot); the ledger
  // rows (FK → wallet, not bet) survive. (As of F-017 users/wallets/rounds are RESTRICT,
  // NOT cascade-delete — a money record can no longer be erased by deleting its parent;
  // PII is anonymized in place instead. This reconciliation math is unaffected either way.)
  // A closed-book reconciliation therefore compares the ledger against the ledger rows
  // whose bet still exists — joined by ledger.refType='bet' AND ledger.refId = bet.id.
  // (Orphaned debits always had a paired refund, so they net to 0 in the per-wallet
  // balance — Check 2 proves that globally; here we want the bet-centric view.)
  type Agg = { s: bigint | null };
  // Ledger joins are implicitly internal-only (operator bets have no ledger rows),
  // but filter b.operator_id IS NULL explicitly so the bet-side and ledger-side
  // sets provably cover the SAME population (internal/guest book).
  const liveDebit = (
    await prisma.$queryRaw<Agg[]>`
      SELECT COALESCE(SUM(l.amount), 0)::bigint AS s
      FROM ledger_transactions l JOIN game_bets b ON b.id = l.ref_id
      WHERE l.type = 'bet_debit' AND l.ref_type = 'bet' AND b.operator_id IS NULL`
  )[0].s ?? 0n; // negative
  const liveRefund = (
    await prisma.$queryRaw<Agg[]>`
      SELECT COALESCE(SUM(l.amount), 0)::bigint AS s
      FROM ledger_transactions l JOIN game_bets b ON b.id = l.ref_id
      WHERE l.type = 'refund' AND l.ref_type = 'bet' AND b.operator_id IS NULL`
  )[0].s ?? 0n;
  const livePayout = (
    await prisma.$queryRaw<Agg[]>`
      SELECT COALESCE(SUM(l.amount), 0)::bigint AS s
      FROM ledger_transactions l JOIN game_bets b ON b.id = l.ref_id
      WHERE l.type = 'payout_credit' AND l.ref_type = 'bet' AND b.operator_id IS NULL`
  )[0].s ?? 0n;

  // Stakes still HELD (debited and not refunded): the shared WAGERED_STATUSES set
  // (active|cashed_out|busted|payout_pending) from common/bet-status — imported so
  // it can't drift from the app's money definition. Scoped to the internal book.
  const heldStakes =
    (await prisma.bet.aggregate({ where: { operatorId: null, status: { in: [...WAGERED_STATUSES] } }, _sum: { amount: true } }))._sum.amount ?? 0n;
  const bustedStake = (await prisma.bet.aggregate({ where: { operatorId: null, status: "busted" }, _sum: { amount: true } }))._sum.amount ?? 0n;
  const cashedStake = (await prisma.bet.aggregate({ where: { operatorId: null, status: "cashed_out" }, _sum: { amount: true } }))._sum.amount ?? 0n;
  const atRisk = heldStakes - bustedStake - cashedStake; // active + payout_pending stake

  // INVARIANT 1a — DEBIT CONSERVATION (live bets): |Σ bet_debit| − Σ refund == Σ stake(held),
  // summed over ledger rows whose bet still exists. Every debited minor unit is either
  // refunded or still attributed to a live debited bet.
  const debitNetOfRefunds = -liveDebit - liveRefund; // |debit| − refund (live bets only)
  const debitConservationOk = debitNetOfRefunds === heldStakes;
  checks.push({
    name: "1a. debit conservation (live bets: |Σ bet_debit| − Σ refund == Σ stake held)",
    ok: debitConservationOk,
    detail: `live |debit|=${-liveDebit} − refund=${liveRefund} => ${debitNetOfRefunds} vs Σ stake(active|cashed_out|busted|pending)=${heldStakes}` +
      (debitConservationOk ? "" : ` MISMATCH by ${debitNetOfRefunds - heldStakes}`),
  });

  // INVARIANT 1b — PAYOUT CONSERVATION (live bets): Σ payout_credit == Σ payout over
  // PAID wins (cashed_out). A payout_pending win is claimed but NOT yet credited, so it
  // is correctly excluded from the ledger payout total until the reconciler confirms it.
  const paidPayouts = (await prisma.bet.aggregate({ where: { operatorId: null, status: "cashed_out" }, _sum: { payout: true } }))._sum.payout ?? 0n;
  const payoutConservationOk = livePayout === paidPayouts;
  checks.push({
    name: "1b. payout conservation (live bets: Σ payout_credit == Σ payout of paid wins)",
    ok: payoutConservationOk,
    detail: `live payout_credit=${livePayout} vs Σ payout(cashed_out)=${paidPayouts}` +
      (payoutConservationOk ? "" : ` MISMATCH by ${livePayout - paidPayouts}`) +
      `  [kept(busted stake)=${bustedStake}; still-at-risk(active+pending stake)=${atRisk}]`,
  });

  // --- 2. LEDGER ↔ BALANCE: latest balanceAfter per wallet == wallet.balance ---
  // One SQL pass: the newest ledger row per wallet (by createdAt, tie-broken by id)
  // vs the wallet balance. A wallet with no ledger rows is consistent iff balance
  // equals its starting balance — we can't know that here, so only CHECK wallets
  // that have ledger activity (the ones the game touched).
  const balRows = await prisma.$queryRaw<{ wallet_id: string; balance: bigint; balance_after: bigint }[]>`
    SELECT w.id AS wallet_id, w.balance AS balance, lt.balance_after AS balance_after
    FROM wallets w
    JOIN LATERAL (
      SELECT balance_after
      FROM ledger_transactions l
      WHERE l.wallet_id = w.id
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 1
    ) lt ON true
  `;
  const balMismatches = balRows.filter((r) => BigInt(r.balance) !== BigInt(r.balance_after));
  checks.push({
    name: "2. ledger ↔ balance (latest balanceAfter == wallet.balance)",
    ok: balMismatches.length === 0,
    detail: `${balRows.length} wallet(s) with ledger activity checked; ${balMismatches.length} mismatch(es)` +
      (balMismatches.length ? ` e.g. ${balMismatches.slice(0, 3).map((m) => `${m.wallet_id}:bal=${m.balance} vs ledger=${m.balance_after}`).join("; ")}` : ""),
  });

  // --- 3. PAYOUT LINKAGE: every cashed_out win has a payout_credit row + payoutTxId ---
  const cashedOut = await prisma.bet.findMany({
    where: { operatorId: null, status: "cashed_out" },
    select: { id: true, payout: true, payoutTxId: true },
  });
  // Set of payout idempotency keys present in the ledger.
  const payoutKeys = new Set(
    (
      await prisma.ledgerTransaction.findMany({
        where: { type: "payout_credit" },
        select: { idempotencyKey: true },
      })
    ).map((r) => r.idempotencyKey),
  );
  const missingLedger: string[] = [];
  const missingTxId: string[] = [];
  for (const b of cashedOut) {
    if (b.payout > 0n && !payoutKeys.has(`bet:${b.id}:payout`)) missingLedger.push(b.id);
    if (!b.payoutTxId) missingTxId.push(b.id);
  }
  // MONEY-CRITICAL: a paid win with no payout ledger row is money owed-and-lost → hard FAIL.
  checks.push({
    name: "3. payout linkage — ledger row (cashed_out ⇒ payout_credit row)",
    ok: missingLedger.length === 0,
    detail: `${cashedOut.length} cashed_out bet(s); ${missingLedger.length} missing the payout ledger row (money-critical)` +
      (missingLedger.length ? ` e.g. ${missingLedger.slice(0, 3).join(", ")}` : ""),
  });
  // ADVISORY: payoutTxId is a denormalised back-reference, added in a later audit
  // commit. Rows cashed out BEFORE that commit (or via a legacy path) can lack it
  // while the payout ledger row is present (money correct). Surface it but don't fail
  // the run on a non-money backfill gap.
  checks.push({
    name: "3b. payoutTxId backfill (advisory, non-money)",
    ok: missingTxId.length === 0,
    warn: true,
    detail: `${missingTxId.length}/${cashedOut.length} cashed_out bet(s) lack payoutTxId` +
      (missingTxId.length ? ` (cosmetic if their payout ledger row exists — check 3 covers the money). Likely legacy rows.` : ""),
  });

  // --- 4. BUSTED PURITY: no busted bet has a payout_credit row ---
  const busted = await prisma.bet.findMany({ where: { operatorId: null, status: "busted" }, select: { id: true } });
  const paidBusted = busted.filter((b) => payoutKeys.has(`bet:${b.id}:payout`));
  checks.push({
    name: "4. busted purity (no busted bet was paid)",
    ok: paidBusted.length === 0,
    detail: `${busted.length} busted bet(s); ${paidBusted.length} had a payout row` +
      (paidBusted.length ? ` e.g. ${paidBusted.slice(0, 3).map((b) => b.id).join(", ")}` : ""),
  });

  // --- 5. BACKLOG DRAINED: reserving|cancelling|voiding == 0 AND payout_pending == 0 ---
  // `voiding` = an operator void stranded mid-reversal (owed refund not yet finalised);
  // the reconcileVoidingBets sweep drains it, so it must be 0 after a clean soak (Phase 6).
  const reservingSlots = await prisma.bet.count({ where: { status: { in: ["reserving", "cancelling", "voiding"] } } });
  const pendingPayouts = await prisma.bet.count({ where: { status: "payout_pending" } });
  checks.push({
    name: "5. backlog drained (reserving|cancelling|voiding == 0, payout_pending == 0)",
    ok: reservingSlots === 0 && pendingPayouts === 0,
    detail: `reserving|cancelling|voiding=${reservingSlots} pending_payouts=${pendingPayouts}`,
  });

  // --- 6. ROLLBACK OUTBOX DRAINED: wallet_rollbacks pending == 0 (operator-mode M1/F-027) ---
  // A failed-emit operator rollback is persisted `pending` and re-issued by the reserving
  // sweep's drain until the operator confirms it. After a clean soak it must be 0. (Like
  // payout_pending, a mid-soak non-zero is the sweep's backlog, not a money discrepancy.)
  // Count BOTH pending and draining (matches MetricsService.countPending / the gauge): a
  // row crashed mid-emit sits `draining` until its lease expires + the next sweep reclaims
  // it, so counting only `pending` could read a false "drained" for that window.
  const pendingRollbacks = await prisma.walletRollback.count({ where: { status: { in: ["pending", "draining"] } } });
  checks.push({
    name: "6. rollback outbox drained (wallet_rollbacks pending == 0)",
    ok: pendingRollbacks === 0,
    detail: `wallet_rollbacks pending=${pendingRollbacks}` +
      (pendingRollbacks ? ` (a mid-soak backlog is the sweep's, not a discrepancy — let it drain)` : ""),
  });

  // ---- report ----
  console.log("\n=== Vault Run ledger-vs-bets reconciliation (Phase 4.4 / SLA #4) ===\n");
  console.log("scope: INTERNAL ledger book (operatorId IS NULL). Invariants 2 & 5 are mode-agnostic.");
  if (operatorBets > 0) {
    console.log(
      `NOTE: ${operatorBets} operator-mode bet(s) are OUT OF SCOPE for this gate — they keep their book on the\n` +
        `      operator side (no ledger rows) and are reconciled against the operator statement in the 4.5 soak.`,
    );
  }
  console.log(`ledger totals (minor units): deposit=${deposit} |debit|=${-debit} payout=${payout} refund=${refund} adjustment=${adjustment}`);
  console.log(`internal bet counts: cashed_out=${cashedOut.length} busted=${busted.length} reserving|cancelling=${reservingSlots} payout_pending=${pendingPayouts}\n`);
  let allOk = true;
  for (const c of checks) {
    const tag = c.ok ? "PASS" : c.warn ? "WARN" : "FAIL";
    console.log(`  [${tag}] ${c.name}`);
    console.log(`         ${c.detail}`);
    // A `warn` check is advisory (non-money) — it never fails the run.
    if (!c.warn) allOk = allOk && c.ok;
  }
  console.log(`\nRESULT: ${allOk ? "RECONCILED — 0 money discrepancies" : "MONEY DISCREPANCIES FOUND"}\n`);
  await prisma.$disconnect();
  process.exit(allOk ? 0 : 1);
}

main().catch(async (e) => {
  console.error("reconcile-check failed:", e?.message ?? e);
  await prisma.$disconnect();
  process.exit(2);
});
