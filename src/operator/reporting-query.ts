import { BadRequestException } from "@nestjs/common";
import { UUID_RE } from "../common/uuid";
import { CURRENCY_CODE_RE } from "../common/currency";

/**
 * Parsing + validation for the operator reporting query params (Phase 3.5).
 *
 * Reads ONLY known keys off the raw query (never spreads it) → prototype-pollution
 * safe and immune to `?from[x]=y` object-injection (a non-string value validates as
 * missing). All amounts/dates are validated before they reach any query. The
 * operatorId is NEVER read from here — it comes only from OperatorAuthGuard.
 */

export interface ReportQuery {
  from: Date;
  to: Date;
  currency?: string; // canonical UPPERCASE, optional filter
  includeDemo: boolean; // default false → real money only
}

export interface BetsQuery extends ReportQuery {
  cursor?: string; // a bet id (keyset pagination)
  limit: number; // clamped to [1, MAX_LIMIT]
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
export const MAX_DAILY_RANGE_DAYS = 366;

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Parse an ISO instant. A date-only value (YYYY-MM-DD) snaps to start-of-day (from)
 *  or end-of-day (to) in UTC, so an intuitive `from=2026-06-01&to=2026-06-04` covers
 *  the whole of the 4th. A datetime is used verbatim. */
function parseInstant(raw: unknown, which: "from" | "to"): Date {
  const s = asString(raw)?.trim();
  if (!s) throw new BadRequestException(`missing ${which} date`);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const iso = dateOnly ? `${s}T${which === "to" ? "23:59:59.999" : "00:00:00.000"}Z` : s;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`invalid ${which} date`);
  return d;
}

function parseCurrency(raw: unknown): string | undefined {
  const s = asString(raw);
  if (s === undefined) return undefined;
  const c = s.trim().toUpperCase();
  if (!CURRENCY_CODE_RE.test(c)) throw new BadRequestException("invalid currency");
  return c;
}

function parseBool(raw: unknown, def: boolean): boolean {
  const s = asString(raw);
  if (s === undefined) return def;
  if (s === "true") return true;
  if (s === "false") return false;
  throw new BadRequestException("includeDemo must be true|false");
}

function base(q: Record<string, unknown>): ReportQuery {
  const from = parseInstant(q.from, "from");
  const to = parseInstant(q.to, "to");
  if (from.getTime() > to.getTime()) throw new BadRequestException("from must be <= to");
  return { from, to, currency: parseCurrency(q.currency), includeDemo: parseBool(q.includeDemo, false) };
}

export function parseReportQuery(query: unknown): ReportQuery {
  return base((query ?? {}) as Record<string, unknown>);
}

/** Daily time-series — bounds the range (JS bucketing pulls rows) to a sane window. */
export function parseDailyQuery(query: unknown): ReportQuery {
  const q = base((query ?? {}) as Record<string, unknown>);
  const days = (q.to.getTime() - q.from.getTime()) / 86_400_000;
  if (days > MAX_DAILY_RANGE_DAYS)
    throw new BadRequestException(`daily range too large (max ${MAX_DAILY_RANGE_DAYS} days)`);
  return q;
}

export function parseBetsQuery(query: unknown): BetsQuery {
  const q = (query ?? {}) as Record<string, unknown>;
  const b = base(q);
  const cursor = asString(q.cursor)?.trim() || undefined;
  if (cursor !== undefined && !UUID_RE.test(cursor)) throw new BadRequestException("invalid cursor");
  let limit = DEFAULT_LIMIT;
  const lr = asString(q.limit);
  if (lr !== undefined) {
    const n = Number(lr);
    if (!Number.isInteger(n) || n < 1) throw new BadRequestException("invalid limit");
    limit = Math.min(n, MAX_LIMIT);
  }
  return { ...b, cursor, limit };
}

/**
 * Transaction-status lookup (Phase 6) — resolve ONE money-move to its bet. The
 * operator queries by EITHER our `betId` (a uuid we send on every wallet call) OR
 * the `transactionId` (idempotency key) we sent — useful when a `/bet` or `/win`
 * response was lost and the operator must learn the final disposition. The
 * transactionId formats are the RGS idempotency keys (see api-integration-spec §9):
 *   bet:{roundId}:{userId}:{panel}:debit   (a stake debit)
 *   bet:{betId}:payout                      (a payout credit)
 *   bet:{betId}:refund                      (a cancel/refund credit)
 *   bet:{betId}:restart_refund             (a recovery/failover refund credit)
 * Reads ONLY known keys (prototype-pollution safe); the operatorId is NEVER read
 * here (it comes only from OperatorAuthGuard). Exactly one of the two is required.
 */
export type TransactionQuery =
  | { kind: "betId"; betId: string; transactionId?: undefined }
  | { kind: "debit"; roundId: string; userId: string; panel: "A" | "B"; transactionId: string }
  | { kind: "payout" | "refund"; betId: string; transactionId: string };

export function parseTransactionQuery(query: unknown): TransactionQuery {
  const q = (query ?? {}) as Record<string, unknown>;
  const transactionId = asString(q.transactionId)?.trim() || undefined;
  const betId = asString(q.betId)?.trim() || undefined;
  if (transactionId && betId) throw new BadRequestException("provide exactly one of transactionId or betId");
  if (!transactionId && !betId) throw new BadRequestException("missing transactionId or betId");

  if (betId) {
    if (!UUID_RE.test(betId)) throw new BadRequestException("invalid betId");
    return { kind: "betId", betId };
  }

  const parts = transactionId!.split(":");
  if (parts[0] !== "bet") throw new BadRequestException("unrecognized transactionId");
  // bet:{betId}:payout | bet:{betId}:refund | bet:{betId}:restart_refund
  // (refund + restart_refund are both refund-class credits resolving to the same betId.)
  if (parts.length === 3 && (parts[2] === "payout" || parts[2] === "refund" || parts[2] === "restart_refund")) {
    if (!UUID_RE.test(parts[1])) throw new BadRequestException("unrecognized transactionId");
    return { kind: parts[2] === "payout" ? "payout" : "refund", betId: parts[1], transactionId: transactionId! };
  }
  // bet:{roundId}:{userId}:{panel}:debit
  if (parts.length === 5 && parts[4] === "debit") {
    const [, roundId, userId, panel] = parts;
    if (!UUID_RE.test(roundId) || !UUID_RE.test(userId) || (panel !== "A" && panel !== "B"))
      throw new BadRequestException("unrecognized transactionId");
    return { kind: "debit", roundId, userId, panel, transactionId: transactionId! };
  }
  throw new BadRequestException("unrecognized transactionId");
}
