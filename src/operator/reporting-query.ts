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
