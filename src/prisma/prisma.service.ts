import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * Audit H5 / F-048b — a Postgres `statement_timeout` (+ `idle_in_transaction_session_timeout`)
 * on the APPLICATION connection so a WEDGED query/connection can never hang the round loop
 * indefinitely (the silent-stall root cause: a phase awaiting a query that never returns).
 *
 * WHY a connection-string `options` param and not a per-session `SET`: Prisma pools many
 * connections, so a `SET` in onModuleInit would only cover ONE of them. Passing libpq's
 * `options=-c statement_timeout=...` through the datasource URL makes PG apply it to EVERY
 * pooled connection at connect time — uniformly, with no per-query plumbing.
 *
 * SCOPE: this is ONLY the pooled app client. The leader-election heartbeat runs on its OWN
 * dedicated `pg.Client` (PgAdvisoryLock), which strips Prisma params and is DELIBERATELY left
 * with no statement_timeout — its liveness SELECT 1 must never be killed by a query timeout
 * (that would false-demote the leader). See pg-advisory-lock.ts.
 *
 * VALUES (overridable via env for tests / heavy migrations):
 *  - statement_timeout = 8000ms. The heaviest legitimate app query is a settlement
 *    updateMany over one round's bets — sub-second in practice. 8s is comfortably above any
 *    real query yet (a) below the engine's 10s per-phase deadline (F-048a) so a wedged query
 *    REJECTS and is caught by safe()'s reschedule before the phase deadline even fires, and
 *    (b) far below the multi-minute stall window. Set ENGINE_DB_STATEMENT_TIMEOUT_MS=0 to
 *    disable (e.g. a long data migration run via this client).
 *  - idle_in_transaction_session_timeout = 10000ms. Reaps a transaction left open by a
 *    crashed/wedged code path so it can't hold locks forever. > statement_timeout (a single
 *    long statement is bounded by the former) but still short.
 */
const STATEMENT_TIMEOUT_MS = numEnv("ENGINE_DB_STATEMENT_TIMEOUT_MS", 8000);
const IDLE_TX_TIMEOUT_MS = numEnv("ENGINE_DB_IDLE_TX_TIMEOUT_MS", 10000);

function numEnv(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/**
 * Append libpq `options=-c key=val` flags to the datasource URL so PG applies them to every
 * pooled connection. Merges with any existing `options` and preserves all other params
 * (?schema=public, connection_limit, …). Returns the URL unchanged on a parse failure (Prisma
 * then connects exactly as before) or when DATABASE_URL is unset (let Prisma raise its own
 * clear error). statement_timeout=0 means "disabled" → that flag is omitted.
 */
export function withStatementTimeout(
  url: string | undefined,
  statementTimeoutMs = STATEMENT_TIMEOUT_MS,
  idleTxTimeoutMs = IDLE_TX_TIMEOUT_MS,
): string | undefined {
  if (!url) return url;
  const flags: string[] = [];
  if (statementTimeoutMs > 0) flags.push(`-c statement_timeout=${statementTimeoutMs}`);
  if (idleTxTimeoutMs > 0) flags.push(`-c idle_in_transaction_session_timeout=${idleTxTimeoutMs}`);
  if (flags.length === 0) return url;
  try {
    const u = new URL(url);
    const existing = u.searchParams.get("options");
    u.searchParams.set("options", existing ? `${existing} ${flags.join(" ")}` : flags.join(" "));
    // Rebuild from components (NOT u.origin — the non-special `postgresql:` scheme yields
    // origin === "null", which would corrupt the host; same gotcha as stripPrismaParams).
    const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ""}@` : "";
    const qs = u.searchParams.toString();
    return `${u.protocol}//${auth}${u.host}${u.pathname}${qs ? `?${qs}` : ""}`;
  } catch {
    return url; // unparseable — hand Prisma the original
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PrismaService.name);

  constructor() {
    super({
      // F-048b: pin statement_timeout / idle_in_transaction_session_timeout on the app pool.
      datasourceUrl: withStatementTimeout(process.env.DATABASE_URL),
      // F-048b: a default per-interactive-transaction budget so $transaction(fn) can't hang
      // forever either. maxWait = time to get a connection; timeout = total tx budget. Kept a
      // touch under the per-phase deadline; raise via Prisma's per-call options for any rare
      // heavier tx. (No-op for the non-interactive $transaction([...]) array form.)
      transactionOptions: {
        maxWait: numEnv("ENGINE_DB_TX_MAXWAIT_MS", 5000),
        timeout: numEnv("ENGINE_DB_TX_TIMEOUT_MS", 8000),
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
    if (STATEMENT_TIMEOUT_MS > 0) {
      this.log.log(
        `app DB connection bounded: statement_timeout=${STATEMENT_TIMEOUT_MS}ms, idle_in_transaction_session_timeout=${IDLE_TX_TIMEOUT_MS}ms (F-048b)`,
      );
    }
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
