/**
 * OPERATOR-BOOK reconciliation check (Phase 4.5c.3 — the operator-mode counterpart to
 * scripts/reconcile-check.ts, which is INTERNAL-book-only `operatorId IS NULL`).
 *
 * WHY a separate gate: an operator-mode bet keeps NO ledger row in our DB — its money
 * lives on the OPERATOR's book (here, the load/operator-wallet-stub.ts in-memory book).
 * scripts/reconcile-check.ts therefore reports operator bets as out-of-scope. For an
 * OPERATOR-mode soak we must reconcile our `game_bets` (operatorId IS NOT NULL) against
 * the operator's own book. The stub records, per server betId, the bet/win/rollback it
 * received (the seamless wallet sends `betId` on every move) and serves it at
 * GET /debug/book. This script cross-matches the two.
 *
 * INVARIANTS (operator book):
 *  O1. WIN LINKAGE  — every `cashed_out` operator bet has exactly ONE win on the operator
 *      book, with win == bet.payout. A cashed win with no operator win = money owed-and-lost.
 *  O2. BUSTED PURITY — every `busted` operator bet has a bet (debit) but NO win. A busted
 *      bet that got a win = the operator paid a loser.
 *  O3. STAKE LINKAGE — every wagered operator bet (active|cashed_out|busted|payout_pending)
 *      has a matching bet (debit) on the operator book == bet.amount (net of rollback).
 *  O4. BACKLOG DRAINED — no operator bet left in reserving|cancelling|payout_pending
 *      (mode-agnostic; same as internal invariant 5, scoped to operatorId IS NOT NULL).
 *  O5. CONSERVATION — on the operator book, Σ(bet) − Σ(win) − Σ(rollback) == the operator's
 *      net balance drop for those players (the stub exposes counts; we recompute from book).
 *
 * USAGE (after an operator-mode soak: ws-load.ts AUTH_MODE=operator against a target-op box):
 *   DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
 *     STUB_URL=http://localhost:4001 STUB_KEY=stub-key OPERATOR_CODE=load-stub \
 *     bun scripts/operator-recon-check.ts
 *
 * Exits non-zero on any discrepancy (CI/soak-gate friendly), like reconcile-check.ts.
 * NOTE: the stub's book is IN-MEMORY — run this BEFORE the stub is restarted. For a real
 * operator the equivalent input is the operator's transaction statement/report.
 */
import { PrismaClient } from "@prisma/client";
import { WAGERED_STATUSES } from "../src/common/bet-status";

const prisma = new PrismaClient();

const STUB_URL = process.env.STUB_URL ?? "http://localhost:4001";
const STUB_KEY = process.env.STUB_KEY ?? "stub-key";
const OPERATOR_CODE = process.env.OPERATOR_CODE ?? "load-stub";

interface BookEntry { bet: number; win: number; rollback: number; player: string; currency: string }
interface StubBook { counts: Record<string, number>; players: number; book: Record<string, BookEntry> }

interface Check { name: string; ok: boolean; detail: string }

async function main() {
  // 1) Pull the operator's book (the stub's /debug/book; a real operator → its statement).
  let stub: StubBook;
  try {
    const r = await fetch(`${STUB_URL}/debug/book`, { headers: { authorization: `Bearer ${STUB_KEY}` } });
    if (!r.ok) {
      console.error(`could not read operator book at ${STUB_URL}/debug/book (HTTP ${r.status}). Is the stub still running with the run's in-memory book?`);
      process.exit(2);
    }
    stub = (await r.json()) as StubBook;
  } catch (e: any) {
    console.error(`operator book unreachable at ${STUB_URL}: ${e?.message}`);
    process.exit(2);
  }

  // 2) The operator under test.
  const op = await prisma.operator.findUnique({ where: { code: OPERATOR_CODE } });
  if (!op) {
    console.error(`no operator with code "${OPERATOR_CODE}" — set OPERATOR_CODE.`);
    process.exit(2);
  }

  // 3) Our operator bets.
  const opBets = await prisma.bet.findMany({
    where: { operatorId: op.id },
    select: { id: true, status: true, amount: true, payout: true },
  });
  const cashed = opBets.filter((b) => b.status === "cashed_out");
  const busted = opBets.filter((b) => b.status === "busted");
  const wagered = opBets.filter((b) => (WAGERED_STATUSES as readonly string[]).includes(b.status));

  const checks: Check[] = [];
  const book = stub.book;

  // O1 — WIN LINKAGE (cashed_out ⇒ exactly one win == payout on the operator book).
  const o1miss: string[] = [];
  const o1mismatch: string[] = [];
  for (const b of cashed) {
    const e = book[b.id];
    if (!e || e.win <= 0) o1miss.push(b.id);
    else if (BigInt(e.win) !== BigInt(b.payout)) o1mismatch.push(`${b.id}(book=${e.win} vs payout=${b.payout})`);
  }
  checks.push({
    name: "O1. win linkage (cashed_out ⇒ operator win == payout)",
    ok: o1miss.length === 0 && o1mismatch.length === 0,
    detail: `${cashed.length} cashed_out op-bet(s); missing-win=${o1miss.length} amount-mismatch=${o1mismatch.length}` +
      (o1miss.length ? ` missing e.g. ${o1miss.slice(0, 3).join(", ")}` : "") +
      (o1mismatch.length ? ` mismatch e.g. ${o1mismatch.slice(0, 3).join(", ")}` : ""),
  });

  // O2 — BUSTED PURITY (busted ⇒ a bet but NO win on the operator book).
  const o2paid = busted.filter((b) => book[b.id] && book[b.id].win > 0).map((b) => b.id);
  checks.push({
    name: "O2. busted purity (no busted op-bet got an operator win)",
    ok: o2paid.length === 0,
    detail: `${busted.length} busted op-bet(s); ${o2paid.length} got a win` + (o2paid.length ? ` e.g. ${o2paid.slice(0, 3).join(", ")}` : ""),
  });

  // O3 — STAKE LINKAGE (every wagered op-bet ⇒ bet debit == amount, net of rollback).
  const o3miss: string[] = [];
  const o3mismatch: string[] = [];
  for (const b of wagered) {
    const e = book[b.id];
    const net = e ? e.bet - e.rollback : 0;
    if (!e || net <= 0) o3miss.push(b.id);
    else if (BigInt(net) !== BigInt(b.amount)) o3mismatch.push(`${b.id}(book=${net} vs amount=${b.amount})`);
  }
  checks.push({
    name: "O3. stake linkage (wagered op-bet ⇒ operator bet debit == stake)",
    ok: o3miss.length === 0 && o3mismatch.length === 0,
    detail: `${wagered.length} wagered op-bet(s); missing-debit=${o3miss.length} amount-mismatch=${o3mismatch.length}` +
      (o3miss.length ? ` missing e.g. ${o3miss.slice(0, 3).join(", ")}` : "") +
      (o3mismatch.length ? ` mismatch e.g. ${o3mismatch.slice(0, 3).join(", ")}` : ""),
  });

  // O4 — BACKLOG DRAINED (no operator bet stuck reserving|cancelling|payout_pending).
  const backlog = opBets.filter((b) => ["reserving", "cancelling", "payout_pending"].includes(b.status));
  checks.push({
    name: "O4. backlog drained (no op-bet in reserving|cancelling|payout_pending)",
    ok: backlog.length === 0,
    detail: `${backlog.length} op-bet(s) in a transient state` + (backlog.length ? ` e.g. ${backlog.slice(0, 3).map((b) => `${b.id}:${b.status}`).join(", ")}` : ""),
  });

  // O5 — CONSERVATION on the operator book. The net DROP in player balances is purely a
  // function of the book: netDrop = Σbet − Σwin − Σrollback (a rollback returns money). We
  // validate that against the bet-status accounting in OUR DB:
  //   Σbet(net of rollback) == Σ stake over all wagered bets   (each bet debited once)
  //   Σwin                   == Σ payout over cashed_out bets   (each win paid the payout)
  // ⇒ netDrop == Σ stake(wagered) − Σ payout(cashed). NOTE a WIN pays the full payout
  // (stake × multiplier), NOT just the stake — so Σwin > cashedStake; the house "drop" is
  // busted+at-risk stake MINUS the profit paid on wins. Comparing to a stake-only "kept"
  // figure (the earlier draft) is wrong; this identity is the correct one.
  let sumBet = 0n, sumWin = 0n, sumRollback = 0n;
  for (const b of opBets) {
    const e = book[b.id];
    if (!e) continue;
    sumBet += BigInt(e.bet);
    sumWin += BigInt(e.win);
    sumRollback += BigInt(e.rollback);
  }
  const wageredStake = wagered.reduce((a, b) => a + BigInt(b.amount), 0n);
  const cashedPayout = cashed.reduce((a, b) => a + BigInt(b.payout), 0n);
  const netDrop = sumBet - sumWin - sumRollback;
  const expectedDrop = wageredStake - cashedPayout;
  checks.push({
    name: "O5. operator-book conservation (Σbet − Σwin − Σrollback == Σstake(wagered) − Σpayout(cashed))",
    ok: netDrop === expectedDrop,
    detail: `book: Σbet=${sumBet} Σwin=${sumWin} Σrollback=${sumRollback} ⇒ netDrop=${netDrop}; ` +
      `DB: Σstake(wagered)=${wageredStake} − Σpayout(cashed)=${cashedPayout} = ${expectedDrop}` +
      (netDrop === expectedDrop ? "" : ` MISMATCH by ${netDrop - expectedDrop}`),
  });

  // ---- report ----
  console.log("\n=== Vault Run OPERATOR-book reconciliation (Phase 4.5c.3) ===\n");
  console.log(`operator: ${OPERATOR_CODE} (${op.id})  | book source: ${STUB_URL}/debug/book`);
  console.log(`stub counts: ${JSON.stringify(stub.counts)} players=${stub.players}`);
  console.log(`our op-bets: total=${opBets.length} cashed_out=${cashed.length} busted=${busted.length} wagered=${wagered.length}\n`);
  let allOk = true;
  for (const c of checks) {
    console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${c.name}`);
    console.log(`         ${c.detail}`);
    allOk = allOk && c.ok;
  }
  console.log(`\nRESULT: ${allOk ? "OPERATOR BOOK RECONCILED — 0 discrepancies" : "OPERATOR-BOOK DISCREPANCIES FOUND"}\n`);
  await prisma.$disconnect();
  process.exit(allOk ? 0 : 1);
}

main().catch(async (e) => {
  console.error("operator-recon-check failed:", e?.message ?? e);
  await prisma.$disconnect();
  process.exit(2);
});
