/**
 * Phase 4.5c.3 — FAILURE-INJECTED RECONCILIATION SOAK (SLA #4: "0 reconciliation
 * discrepancies / 1e6 rounds"). Drives many rounds while REPEATEDLY SIGKILLing the
 * engine leader (a survivor resumes — 4.5c.2) so the idempotent recovery paths
 * (resumeRound honor-pay, recoverInterruptedRounds close+refund, recoverReservingBets,
 * settleRound CAS) are actually EXERCISED, then asserts money conservation holds.
 *
 * WHY a DELTA, not absolute invariants: a long-lived dev DB accumulates legitimate
 * orphan ledger rows (the engine DELETES bet rows on placeBet-failure / reserving-
 * recovery while their FK-to-wallet ledger rows survive — see reconcile-check.ts §80-85).
 * Those net to 0 in the per-wallet balance (Check 2), but they make the bet-CENTRIC
 * debit-conservation sum (1a) carry a constant non-zero residual that has NOTHING to do
 * with this soak. So this soak SNAPSHOTS the reconciliation residuals BEFORE driving any
 * load and asserts the soak introduced **0 NEW** discrepancies — pre-existing cruft can
 * neither fail a clean soak nor mask a real new leak. For a pristine PASS/FAIL on the
 * canonical gate too, pass RESET_DB=1 to TRUNCATE the play tables first (DEV ONLY).
 *
 * The mode-agnostic invariants — (2) ledger↔balance and (5) backlog drained — are
 * asserted ABSOLUTELY (they must hold for the WHOLE DB regardless of history): a money
 * leak or a stuck reserving/payout_pending backlog after the soak is a hard FAIL.
 *
 * SCOPE: internal (guest) book — the soak clients auth as guests, so settlement is the
 * internal ledger. The operator-book soak (toxiproxy faults forcing payout_pending +
 * operator-statement reconciliation) reuses ws-load.ts AUTH_MODE=operator and is the
 * staging operator-soak; here the internal-ledger conservation under failover is proven.
 *
 * LOCAL vs STAGING: run a LOCALLY-FEASIBLE round count (default ROUNDS=40 ≈ a few
 * minutes; each round ~11.6s + run). The full 1e6-round run needs a STABLE long-running
 * multi-node env (Docker Desktop here has ~30-60s up-windows) — staging-gated. The
 * harness + assertions are identical at any scale; only ROUNDS / DURATION change.
 *
 * ENV:
 *   PORT_A (3031) / PORT_B (3032)   the two node ports
 *   ROUNDS         (40)             stop after the engine completes this many rounds
 *   MAX_MS         (480000)         hard cap (give up even if ROUNDS not reached)
 *   CLIENTS        (24)             guest load clients (split across both nodes)
 *   BET_RATE       (0.7)            fraction betting each window
 *   BET_AMOUNT     (50)             stake (minor units)
 *   CASHOUT_AT     (0)             auto-cashout target; 0 ⇒ ride to bust (more settle churn)
 *   KILL_EVERY_MS  (15000)         SIGKILL the current leader on this cadence (0 = no kills)
 *   RESET_DB       (0)             1 ⇒ TRUNCATE play tables first (DEV ONLY; pristine gate)
 *   DATABASE_URL / REDIS_URL / JWT_SECRET / GAME_CURRENCY  (passed to children)
 *
 * RUN:
 *   DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
 *     REDIS_URL="redis://localhost:6379" JWT_SECRET=x GAME_CURRENCY=DEMO \
 *     ROUNDS=40 KILL_EVERY_MS=15000 bun load/recon-soak.ts
 */
import { PrismaClient } from "@prisma/client";
import { WAGERED_STATUSES } from "../src/common/bet-status";
import {
  bootNode,
  waitHealthy,
  currentLeader,
  killAll,
  startGuestClient,
  sleep,
  now,
  type Node,
  type HarnessClient,
} from "./cluster-harness";

const CFG = {
  PORT_A: Number(process.env.PORT_A ?? 3031),
  PORT_B: Number(process.env.PORT_B ?? 3032),
  ROUNDS: Number(process.env.ROUNDS ?? 40),
  MAX_MS: Number(process.env.MAX_MS ?? 480000),
  CLIENTS: Number(process.env.CLIENTS ?? 24),
  BET_RATE: Number(process.env.BET_RATE ?? 0.7),
  BET_AMOUNT: Number(process.env.BET_AMOUNT ?? 50),
  CASHOUT_AT: Number(process.env.CASHOUT_AT ?? 0),
  KILL_EVERY_MS: Number(process.env.KILL_EVERY_MS ?? 15000),
  RESET_DB: /^(1|true|yes)$/i.test(process.env.RESET_DB ?? ""),
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://vault:vault@localhost:5432/vaultrun?schema=public",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
};

// ---- reconciliation residual snapshot (the DELTA basis) ----
interface Residuals {
  // 1a residual: heldStakes − (|liveDebit| − liveRefund). Constant under orphan rows.
  debitResidual: bigint;
  // 1b residual: livePayout − Σ payout(cashed_out). Must stay 0.
  payoutResidual: bigint;
  // mode-agnostic, asserted ABSOLUTELY (not delta): these must be 0 outright.
  balanceMismatches: number;
  reservingBacklog: number;
  pendingBacklog: number;
  // context
  cashedOut: number;
  busted: number;
  missingPayoutLedger: number; // cashed_out with no payout_credit row (money-critical)
  paidBusted: number; // busted with a payout row (money-critical)
}

async function snapshotResiduals(prisma: PrismaClient): Promise<Residuals> {
  const q = (type: string, ledgerType: string) =>
    prisma.$queryRawUnsafe<{ s: bigint }[]>(
      `SELECT COALESCE(SUM(l.amount),0)::bigint AS s FROM ledger_transactions l
       JOIN game_bets b ON b.id = l.ref_id
       WHERE l.type = $1 AND l.ref_type = 'bet' AND b.operator_id IS NULL`,
      ledgerType,
    ).then((r) => BigInt(r[0]?.s ?? 0n));

  const liveDebit = await q("d", "bet_debit"); // negative
  const liveRefund = await q("r", "refund");
  const livePayout = await q("p", "payout_credit");
  const heldStakes =
    (await prisma.bet.aggregate({ where: { operatorId: null, status: { in: [...WAGERED_STATUSES] } }, _sum: { amount: true } }))._sum.amount ?? 0n;
  const paidPayouts =
    (await prisma.bet.aggregate({ where: { operatorId: null, status: "cashed_out" }, _sum: { payout: true } }))._sum.payout ?? 0n;

  const debitResidual = heldStakes - (-liveDebit - liveRefund);
  const payoutResidual = livePayout - paidPayouts;

  // Mode-agnostic absolute checks.
  const balRows = await prisma.$queryRaw<{ wallet_id: string }[]>`
    SELECT w.id AS wallet_id
    FROM wallets w
    JOIN LATERAL (
      SELECT balance_after FROM ledger_transactions l
      WHERE l.wallet_id = w.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1
    ) lt ON true
    WHERE w.balance <> lt.balance_after`;
  const reservingBacklog = await prisma.bet.count({ where: { status: { in: ["reserving", "cancelling"] } } });
  const pendingBacklog = await prisma.bet.count({ where: { status: "payout_pending" } });

  // Money-critical linkage counts (must not grow).
  const cashedOut = await prisma.bet.count({ where: { operatorId: null, status: "cashed_out" } });
  const busted = await prisma.bet.count({ where: { operatorId: null, status: "busted" } });
  const cashedRows = await prisma.bet.findMany({
    where: { operatorId: null, status: "cashed_out" },
    select: { id: true, payout: true },
  });
  const bustedRows = await prisma.bet.findMany({ where: { operatorId: null, status: "busted" }, select: { id: true } });
  const payoutKeys = new Set(
    (await prisma.ledgerTransaction.findMany({ where: { type: "payout_credit" }, select: { idempotencyKey: true } })).map(
      (r) => r.idempotencyKey,
    ),
  );
  let missingPayoutLedger = 0;
  for (const b of cashedRows) if (b.payout > 0n && !payoutKeys.has(`bet:${b.id}:payout`)) missingPayoutLedger++;
  let paidBusted = 0;
  for (const b of bustedRows) if (payoutKeys.has(`bet:${b.id}:payout`)) paidBusted++;

  return {
    debitResidual,
    payoutResidual,
    balanceMismatches: balRows.length,
    reservingBacklog,
    pendingBacklog,
    cashedOut,
    busted,
    missingPayoutLedger,
    paidBusted,
  };
}

async function resetPlayTables(prisma: PrismaClient) {
  // DEV ONLY: wipe the play tables for a pristine baseline. Order respects FKs; CASCADE
  // covers the rest. NEVER point this at staging/prod.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ledger_transactions, game_bets, game_rounds RESTART IDENTITY CASCADE`,
  );
  // engine_leadership is a singleton control row — reset node_id/acquired_at but keep the row.
  await prisma.$executeRawUnsafe(`UPDATE engine_leadership SET node_id = NULL, acquired_at = NULL WHERE id = true`);
}

function childEnv(port: number) {
  return {
    PORT: port,
    DATABASE_URL: CFG.DATABASE_URL,
    REDIS_URL: CFG.REDIS_URL,
    JWT_SECRET: process.env.JWT_SECRET ?? "x",
    GAME_CURRENCY: process.env.GAME_CURRENCY ?? "DEMO",
    // internal (guest) book; both nodes election-eligible so the survivor takes over.
  };
}

async function main() {
  console.log("=== Vault Run FAILURE-INJECTED RECONCILIATION SOAK (Phase 4.5c.3 / SLA #4) ===");
  console.log(
    `ports=${CFG.PORT_A},${CFG.PORT_B} rounds=${CFG.ROUNDS} clients=${CFG.CLIENTS} betRate=${CFG.BET_RATE} ` +
      `cashoutAt=${CFG.CASHOUT_AT} killEvery=${CFG.KILL_EVERY_MS}ms reset=${CFG.RESET_DB}`,
  );

  const prisma = new PrismaClient({ datasources: { db: { url: CFG.DATABASE_URL } } });
  const { io } = (await import("socket.io-client")) as typeof import("socket.io-client");

  if (CFG.RESET_DB) {
    console.log("RESET_DB=1 → TRUNCATEing play tables for a pristine baseline (DEV ONLY)…");
    await resetPlayTables(prisma);
  }

  // BEFORE snapshot — the delta basis.
  const before = await snapshotResiduals(prisma);
  console.log(
    `baseline residuals: debit=${before.debitResidual} payout=${before.payoutResidual} ` +
      `balMismatch=${before.balanceMismatches} reserving=${before.reservingBacklog} pending=${before.pendingBacklog} ` +
      `(cashed=${before.cashedOut} busted=${before.busted})`,
  );

  // Boot both nodes (both election-eligible).
  console.log("booting node A…");
  const a = bootNode(childEnv(CFG.PORT_A), `A:${CFG.PORT_A}`);
  await sleep(800);
  console.log("booting node B…");
  const b = bootNode(childEnv(CFG.PORT_B), `B:${CFG.PORT_B}`);
  const nodes = [a, b];
  if (!(await waitHealthy(CFG.PORT_A, 30000)) || !(await waitHealthy(CFG.PORT_B, 30000))) {
    console.error("node health FAILED. Tails:");
    for (const n of nodes) console.error(`  :${n.port}\n    ${n.logTail.slice(-8).join("\n    ")}`);
    await killAll(nodes);
    await prisma.$disconnect();
    process.exit(2);
  }
  await sleep(1500);

  // Attach guest load split across both nodes.
  console.log(`attaching ${CFG.CLIENTS} guest clients…`);
  const clients: HarnessClient[] = [];
  for (let i = 0; i < CFG.CLIENTS; i++) {
    clients.push(
      await startGuestClient(io, i % 2 === 0 ? CFG.PORT_A : CFG.PORT_B, {
        willBet: Math.random() < CFG.BET_RATE,
        betAmount: CFG.BET_AMOUNT,
        cashoutAt: CFG.CASHOUT_AT,
      }),
    );
    await sleep(25);
  }

  // ---- soak loop: count completed rounds, SIGKILL the leader on cadence ----
  const start = now();
  const baseRounds = await prisma.round.count({ where: { status: "completed" } });
  let kills = 0;
  let lastKill = now();
  let completed = 0;
  console.log(`soaking until ${CFG.ROUNDS} new rounds complete (or ${Math.round(CFG.MAX_MS / 1000)}s)…`);
  while (now() - start < CFG.MAX_MS) {
    await sleep(1000);
    completed = (await prisma.round.count({ where: { status: "completed" } })) - baseRounds;

    // Failure injection: SIGKILL the current leader, then respawn a replacement so we keep
    // TWO election-eligible nodes (otherwise after a couple of kills we'd be single-node and
    // a kill would stall). The survivor resumes the in-flight round; the respawn re-joins as
    // the new follower. This is the chaos that exercises every recovery path repeatedly.
    if (CFG.KILL_EVERY_MS > 0 && now() - lastKill >= CFG.KILL_EVERY_MS && completed < CFG.ROUNDS) {
      const lead = await currentLeader(prisma, nodes);
      if (lead.node) {
        const port = lead.node.port;
        console.log(`  [t+${Math.round((now() - start) / 1000)}s] kill #${kills + 1}: SIGKILL leader :${port} (pid ${lead.node.proc.pid}, fence ${lead.fence}); rounds=${completed}/${CFG.ROUNDS}`);
        lead.node.killed = true;
        lead.node.proc.kill("SIGKILL");
        kills++;
        lastKill = now();
        // Respawn a fresh node on the SAME port so we stay 2-node (give the OS a beat to free it).
        await sleep(1500);
        const idx = nodes.indexOf(lead.node);
        nodes[idx] = bootNode(childEnv(port), `${idx === 0 ? "A" : "B"}:${port}`);
        // Don't block the loop on its health; it'll join within a few seconds.
      }
    }

    if (completed >= CFG.ROUNDS) break;
  }

  const elapsedS = Math.round((now() - start) / 1000);
  console.log(`\nsoak done: ${completed} rounds completed in ${elapsedS}s with ${kills} leader SIGKILL(s).`);

  // Let any in-flight settlement + the periodic reserving/pending sweeps drain before
  // we reconcile (a kill mid-settle leaves work the survivor's sweeps finish).
  console.log("draining 12s for sweeps/settlement to settle before reconciling…");
  await sleep(12000);

  // Stop generating, then snapshot AFTER.
  for (const c of clients) {
    try {
      c.socket.close();
    } catch {
      /* ignore */
    }
  }
  await sleep(1000);
  const after = await snapshotResiduals(prisma);

  // ---- assert: the soak introduced 0 NEW discrepancies; absolutes hold ----
  const dDebit = after.debitResidual - before.debitResidual;
  const dPayout = after.payoutResidual - before.payoutResidual;
  const dMissingPayout = after.missingPayoutLedger - before.missingPayoutLedger;
  const dPaidBusted = after.paidBusted - before.paidBusted;

  const clientBets = clients.reduce((a, c) => a + c.bets, 0);
  const clientCashouts = clients.reduce((a, c) => a + c.cashouts, 0);
  const clientBusts = clients.reduce((a, c) => a + c.busts, 0);

  console.log("\n================= RECONCILIATION SOAK RESULT =================");
  console.log(`rounds completed         : ${completed}  (target ${CFG.ROUNDS})  | leader kills: ${kills}`);
  console.log(`client activity          : bets=${clientBets} cashouts=${clientCashouts} busts=${clientBusts}`);
  console.log(`internal bets (cumulative): cashed_out=${after.cashedOut} busted=${after.busted}`);
  console.log("");
  console.log("---- DELTA invariants (soak must add 0 new discrepancies) ----");
  console.log(`Δ debit residual (1a)    : ${dDebit}  ${dDebit === 0n ? "✅ no new debit discrepancy" : "❌ NEW debit discrepancy"}`);
  console.log(`   (baseline ${before.debitResidual} → after ${after.debitResidual}; baseline = pre-existing orphan rows, see header)`);
  console.log(`Δ payout residual (1b)   : ${dPayout}  ${dPayout === 0n ? "✅" : "❌ NEW payout discrepancy"}`);
  console.log(`Δ missing payout ledger  : ${dMissingPayout}  ${dMissingPayout === 0 ? "✅ every new cashed_out has its payout row" : "❌ a paid win lost its ledger row"}`);
  console.log(`Δ paid-busted (purity)   : ${dPaidBusted}  ${dPaidBusted === 0 ? "✅ no bust was paid" : "❌ a bust got paid"}`);
  console.log("");
  console.log("---- ABSOLUTE invariants (must hold for the whole DB) ----");
  console.log(`ledger↔balance mismatches: ${after.balanceMismatches}  ${after.balanceMismatches === 0 ? "✅ money conserved per wallet" : "❌ MONEY LEAK"}`);
  console.log(`reserving/cancelling     : ${after.reservingBacklog}  ${after.reservingBacklog === 0 ? "✅ drained" : "❌ stuck backlog"}`);
  console.log(`payout_pending           : ${after.pendingBacklog}  ${after.pendingBacklog === 0 ? "✅ drained" : "❌ stuck backlog"}`);
  console.log("");

  const deltaOk = dDebit === 0n && dPayout === 0n && dMissingPayout === 0 && dPaidBusted === 0;
  const absoluteOk = after.balanceMismatches === 0 && after.reservingBacklog === 0 && after.pendingBacklog === 0;
  const ok = deltaOk && absoluteOk;
  console.log(`VERDICT: reconciliation ${ok ? "CLEAN" : "DISCREPANCY FOUND"} across ${completed} failure-injected rounds (${kills} kills).`);
  if (completed < CFG.ROUNDS) console.log(`  ⚠ only ${completed}/${CFG.ROUNDS} rounds completed (time cap / infra) — re-run longer for more coverage.`);
  console.log(`  NOTE: the canonical gate is scripts/reconcile-check.ts; the full 1e6-round run is STAGING-GATED (Docker Desktop here is too flaky for a multi-hour soak).`);
  console.log("=============================================================\n");

  await killAll(nodes);
  await prisma.$disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => {
  console.error("recon-soak crashed:", e?.message ?? e);
  process.exit(2);
});
