import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WAGERED_STATUSES, isWageredStatus, isWonStatus } from "../common/bet-status";
import { minorUnitsToString, rtpRatioString } from "../common/money";
import { currencyMeta } from "../common/currency";
import type { BetsQuery, ReportQuery, TransactionQuery } from "./reporting-query";

/**
 * Operator REPORTING aggregation (Phase 3.5). Strictly READ-ONLY — it never touches
 * any wallet/ledger and never mutates. Every query is hard-scoped to the operatorId
 * resolved by OperatorAuthGuard (passed in); a client can NEVER widen the scope.
 *
 * Money is summed in BigInt minor units and serialized as decimal STRINGS (sums can
 * exceed 2^53 — see common/money.ts). Demo (play-money) bets are excluded unless
 * includeDemo. Status semantics are the shared WAGERED/WON sets (common/bet-status)
 * so reporting and RG session accounting can never disagree.
 *
 * NOTE on includeDemo=true: it is a COMBINED (debug/ops) view — real + demo turnover
 * are summed into the same per-currency totals (the groupBy keys on currency, not on
 * the demo flag). The DEFAULT (includeDemo=false) is the real-money-only compliance
 * report. If a demo/real split is ever needed, add `demo` to the groupBy `by`.
 *
 * `uniquePlayers` = distinct walletId per currency: one journal wallet exists per
 * (operator, player, currency), so distinct walletId == distinct player. (When
 * includeDemo mixes real + demo, a player's real and demo wallets are distinct
 * journals and count separately — the default real-money report is exact.)
 */

export interface CurrencyStat {
  currency: string;
  decimals: number; // currency precision (Phase 3.6) so a consumer renders the money strings
  betCount: number;
  wagered: string;
  won: string;
  ggr: string; // wagered − won (can be negative on a lucky period)
  uniquePlayers: number;
  rtp: string; // won/wagered, 4 dp, "0" when nothing wagered
}

export interface SummaryResponse {
  operatorId: string;
  from: string;
  to: string;
  includeDemo: boolean;
  currencies: CurrencyStat[];
}

export interface DailyBucket extends CurrencyStat {
  date: string; // YYYY-MM-DD (UTC)
}

export interface DailyResponse {
  operatorId: string;
  from: string;
  to: string;
  includeDemo: boolean;
  days: DailyBucket[];
}

export interface BetRow {
  id: string;
  roundId: string;
  playerId: string | null; // operator-side id (resolved via the session), null if unresolved
  currency: string | null;
  decimals: number; // precision for `currency` (Phase 3.6); fallback 2 when currency is null/unknown
  panel: string;
  amount: string;
  status: string;
  cashoutMult: string | null;
  payout: string;
  demo: boolean;
  createdAt: string;
  settledAt: string | null;
}

export interface BetsResponse {
  operatorId: string;
  from: string;
  to: string;
  includeDemo: boolean;
  bets: BetRow[];
  nextCursor: string | null;
}

export type DebitState = "pending" | "applied" | "reversed";
export type RefundState = "none" | "pending" | "applied";
export type PayoutState = "none" | "pending" | "paid";

// Money-move dispositions derived from the canonical bet status (the single source of
// truth). A transient status is ALWAYS reported as "pending" — never as a flat boolean
// that an operator could read as "did not happen". Pure functions (no I/O), unit-testable.
export function debitStateOf(status: string): DebitState {
  if (status === "reserving" || status === "voiding") return "pending"; // debit may/will be reconciled (reserving) or is mid-reversal (voiding)
  if (status === "cancelled" || status === "voided") return "reversed"; // debit applied then fully refunded (player cancel) / reversed (operator void)
  return "applied"; // active | cashed_out | busted | payout_pending | cancelling → the stake WAS debited
}
export function refundStateOf(status: string): RefundState {
  if (status === "cancelling" || status === "voiding") return "pending"; // a refund/reversal is in flight
  if (status === "cancelled" || status === "voided") return "applied"; // refund/reversal completed
  return "none";
}
export function payoutStateOf(status: string): PayoutState {
  if (status === "cashed_out") return "paid"; // payout credited AND confirmed at the operator
  if (status === "payout_pending" || status === "voiding") return "pending"; // win owed (reconciler) / payout mid-reclaim (voiding)
  return "none"; // voided → the payout (if any) was reclaimed → net none
}

export interface TransactionStatusResponse {
  operatorId: string;
  betId: string;
  roundId: string;
  playerId: string | null; // operator-side id (resolved via the session), null if unresolved
  currency: string | null;
  decimals: number;
  panel: string;
  status: string; // canonical bet status (reserving|active|cashed_out|busted|cancelled|cancelling|payout_pending)
  stake: string; // minor units (the debited amount)
  payout: string; // minor units (0 if none)
  cashoutMult: string | null;
  // Explicit money-move dispositions (never an ambiguous boolean). A TRANSIENT status
  // reads as "pending", NOT as "did not happen" — e.g. `reserving` means the debit may
  // already be applied at the operator and the RGS is reconciling it. See
  // api-integration-spec §13 for the operator-facing contract.
  debitState: DebitState; // pending | applied | reversed
  refundState: RefundState; // none | pending | applied
  payoutState: PayoutState; // none | pending | paid
  // The operator's OWN returned tx ids — best-effort REFERENCES ONLY. A null does NOT
  // mean "not applied" (it may simply be unstamped); reconcile by the *State fields +
  // your own dedup on the transactionId, never by the presence of these.
  debitTxId: string | null;
  payoutTxId: string | null;
  demo: boolean;
  createdAt: string;
  settledAt: string | null;
  query: { transactionId: string | null; betId: string | null; kind: string };
}

// The columns a transaction-status lookup needs (incl. operatorId for the tenant gate).
const TX_SELECT = {
  id: true,
  roundId: true,
  walletId: true,
  operatorId: true,
  currency: true,
  panel: true,
  amount: true,
  status: true,
  cashoutMult: true,
  payout: true,
  debitTxId: true,
  payoutTxId: true,
  demo: true,
  createdAt: true,
  settledAt: true,
} satisfies Prisma.BetSelect;

@Injectable()
export class ReportingService {
  constructor(private readonly prisma: PrismaService) {}

  /** The tenant-scoped base filter. operatorId comes ONLY from the guard. */
  private where(operatorId: string, q: ReportQuery): Prisma.BetWhereInput {
    return {
      operatorId,
      createdAt: { gte: q.from, lte: q.to },
      ...(q.currency ? { currency: q.currency } : {}),
      ...(q.includeDemo ? {} : { demo: false }),
    };
  }

  /** Build one per-currency stat row (money as strings, ggr/rtp derived). Shared by
   *  summary and daily so the formatting can never diverge. */
  private toCurrencyStat(
    currency: string,
    betCount: number,
    wagered: bigint,
    won: bigint,
    uniquePlayers: number,
  ): CurrencyStat {
    return {
      currency,
      decimals: currencyMeta(currency).decimals,
      betCount,
      wagered: minorUnitsToString(wagered),
      won: minorUnitsToString(won),
      ggr: minorUnitsToString(wagered - won),
      uniquePlayers,
      rtp: rtpRatioString(won, wagered),
    };
  }

  async summary(operatorId: string, q: ReportQuery): Promise<SummaryResponse> {
    const where = this.where(operatorId, q);
    // ONE groupBy by [currency, status]; wagered/won/betCount are split in JS by the
    // shared status sets (a single bet contributes to wagered AND won when it won).
    const grouped = await this.prisma.bet.groupBy({
      by: ["currency", "status"],
      where,
      _sum: { amount: true, payout: true },
      _count: { _all: true },
    });
    // distinct (currency, walletId) → unique players per currency (one wallet/player/ccy).
    const playerRows = await this.prisma.bet.groupBy({
      by: ["currency", "walletId"],
      where: { ...where, status: { in: [...WAGERED_STATUSES] } },
    });

    return {
      operatorId,
      from: q.from.toISOString(),
      to: q.to.toISOString(),
      includeDemo: q.includeDemo,
      currencies: this.foldCurrencies(grouped, playerRows),
    };
  }

  private foldCurrencies(
    grouped: Array<{
      currency: string | null;
      status: string;
      _sum: { amount: bigint | null; payout: bigint | null };
      _count: { _all: number };
    }>,
    playerRows: Array<{ currency: string | null }>,
  ): CurrencyStat[] {
    const acc = new Map<string, { betCount: number; wagered: bigint; won: bigint }>();
    for (const g of grouped) {
      const ccy = g.currency;
      if (!ccy) continue; // operator-scoped rows always carry a stamped currency
      const e = acc.get(ccy) ?? { betCount: 0, wagered: 0n, won: 0n };
      if (isWageredStatus(g.status)) {
        e.wagered += g._sum.amount ?? 0n;
        e.betCount += g._count._all;
      }
      if (isWonStatus(g.status)) {
        e.won += g._sum.payout ?? 0n;
      }
      acc.set(ccy, e);
    }
    const playerCounts = new Map<string, number>();
    for (const p of playerRows) {
      if (!p.currency) continue;
      playerCounts.set(p.currency, (playerCounts.get(p.currency) ?? 0) + 1);
    }
    return [...acc.entries()]
      .filter(([, e]) => e.betCount > 0) // drop currencies with only reserving/cancelled noise
      .map(([currency, e]) => this.toCurrencyStat(currency, e.betCount, e.wagered, e.won, playerCounts.get(currency) ?? 0))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }

  async daily(operatorId: string, q: ReportQuery): Promise<DailyResponse> {
    const where = this.where(operatorId, q);
    // Daily buckets need date_trunc, which Prisma groupBy can't express → fetch the
    // minimal columns and bucket in JS (the range is bounded by parseDailyQuery).
    const rows = await this.prisma.bet.findMany({
      where,
      select: { createdAt: true, currency: true, status: true, amount: true, payout: true, walletId: true },
    });
    const buckets = new Map<
      string,
      { date: string; currency: string; betCount: number; wagered: bigint; won: bigint; players: Set<string> }
    >();
    for (const r of rows) {
      const ccy = r.currency;
      if (!ccy) continue;
      const date = r.createdAt.toISOString().slice(0, 10); // YYYY-MM-DD UTC
      const key = `${date} ${ccy}`;
      let b = buckets.get(key);
      if (!b) {
        b = { date, currency: ccy, betCount: 0, wagered: 0n, won: 0n, players: new Set() };
        buckets.set(key, b);
      }
      if (isWageredStatus(r.status)) {
        b.wagered += r.amount;
        b.betCount++;
        b.players.add(r.walletId);
      }
      if (isWonStatus(r.status)) {
        b.won += r.payout;
      }
    }
    const days = [...buckets.values()]
      .filter((b) => b.betCount > 0)
      .map((b) => ({ date: b.date, ...this.toCurrencyStat(b.currency, b.betCount, b.wagered, b.won, b.players.size) }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.currency.localeCompare(b.currency)));
    return { operatorId, from: q.from.toISOString(), to: q.to.toISOString(), includeDemo: q.includeDemo, days };
  }

  async bets(operatorId: string, q: BetsQuery): Promise<BetsResponse> {
    // Validate the cursor belongs to THIS operator (no cross-tenant probing, no 500
    // on a stale id). where{operatorId} already isolates results regardless.
    if (q.cursor) {
      const c = await this.prisma.bet.findUnique({ where: { id: q.cursor }, select: { operatorId: true } });
      if (!c || c.operatorId !== operatorId) throw new BadRequestException("invalid cursor");
    }
    const where = this.where(operatorId, q);
    const rows = await this.prisma.bet.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1, // +1 to detect a next page
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        roundId: true,
        walletId: true,
        currency: true,
        panel: true,
        amount: true,
        status: true,
        cashoutMult: true,
        payout: true,
        demo: true,
        createdAt: true,
        settledAt: true,
      },
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;

    // Resolve operator-side playerId via a bounded GameSession lookup on the page's
    // wallets (Bet has no playerId; the linkage is walletId → GameSession).
    const walletIds = [...new Set(page.map((r) => r.walletId))];
    const sessions = walletIds.length
      ? await this.prisma.gameSession.findMany({
          where: { walletId: { in: walletIds } },
          select: { walletId: true, playerId: true },
        })
      : [];
    const playerByWallet = new Map<string, string>();
    for (const s of sessions) if (!playerByWallet.has(s.walletId)) playerByWallet.set(s.walletId, s.playerId);

    const bets: BetRow[] = page.map((r) => ({
      id: r.id,
      roundId: r.roundId,
      playerId: playerByWallet.get(r.walletId) ?? null,
      currency: r.currency,
      decimals: currencyMeta(r.currency).decimals,
      panel: r.panel,
      amount: minorUnitsToString(r.amount),
      status: r.status,
      cashoutMult: r.cashoutMult ? r.cashoutMult.toString() : null,
      payout: minorUnitsToString(r.payout),
      demo: r.demo,
      createdAt: r.createdAt.toISOString(),
      settledAt: r.settledAt ? r.settledAt.toISOString() : null,
    }));
    return {
      operatorId,
      from: q.from.toISOString(),
      to: q.to.toISOString(),
      includeDemo: q.includeDemo,
      bets,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * Resolve ONE transaction (by our betId, or by the idempotency-key transactionId we
   * sent on a wallet call) to its bet's money disposition. READ-ONLY, tenant-scoped:
   * a bet that isn't this operator's (or doesn't exist, or is internal/guest play with
   * operatorId=null) is reported as NOT FOUND — never leak cross-tenant existence (same
   * posture as the reporting cursor check). Lets an operator that lost a `/bet` or
   * `/win` response learn the final disposition (api-integration-spec §9/§13).
   */
  async transactionStatus(operatorId: string, q: TransactionQuery): Promise<TransactionStatusResponse> {
    const bet =
      q.kind === "debit"
        ? await this.prisma.bet.findUnique({
            where: { roundId_userId_panel: { roundId: q.roundId, userId: q.userId, panel: q.panel } },
            select: TX_SELECT,
          })
        : await this.prisma.bet.findUnique({ where: { id: q.betId }, select: TX_SELECT });

    // Tenant gate: not ours / not found / internal-or-guest (operatorId null) → 404,
    // identical response either way (no cross-tenant existence oracle).
    if (!bet || bet.operatorId !== operatorId) throw new NotFoundException("transaction_not_found");

    // Resolve the operator-side playerId via the wallet→session linkage (Bet has none).
    const session = await this.prisma.gameSession.findFirst({
      where: { walletId: bet.walletId },
      select: { playerId: true },
    });

    return {
      operatorId,
      betId: bet.id,
      roundId: bet.roundId,
      playerId: session?.playerId ?? null,
      currency: bet.currency,
      decimals: currencyMeta(bet.currency).decimals,
      panel: bet.panel,
      status: bet.status,
      stake: minorUnitsToString(bet.amount),
      payout: minorUnitsToString(bet.payout),
      cashoutMult: bet.cashoutMult ? bet.cashoutMult.toString() : null,
      debitState: debitStateOf(bet.status),
      refundState: refundStateOf(bet.status),
      payoutState: payoutStateOf(bet.status),
      debitTxId: bet.debitTxId,
      payoutTxId: bet.payoutTxId,
      demo: bet.demo,
      createdAt: bet.createdAt.toISOString(),
      settledAt: bet.settledAt ? bet.settledAt.toISOString() : null,
      // Echo ONLY what the caller supplied (a transactionId OR a betId), so `query`
      // reflects the input, not a value derived from it.
      query: {
        transactionId: q.kind === "betId" ? null : q.transactionId,
        betId: q.kind === "betId" ? q.betId : null,
        kind: q.kind,
      },
    };
  }
}
