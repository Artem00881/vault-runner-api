import { Logger } from "@nestjs/common";
import { Client } from "pg";
import type Redis from "ioredis";
import type { LeaderLock } from "./leader-lock";

/**
 * Phase 4.5a — the production `LeaderLock`: a Postgres SESSION advisory lock held on
 * a DEDICATED, long-lived `pg.Client` (design §1).
 *
 * Why a standalone `pg.Client` and NOT the pooled Prisma client: a session advisory
 * lock is bound to ONE connection. A pooled connection can be handed to another query
 * between our calls, making `pg_advisory_lock`/`pg_advisory_unlock` ambiguous. A
 * dedicated client guarantees the lock and the heartbeat share exactly one session
 * whose liveness == our leadership.  [money-path-auditor: confirm this connection is
 * NEVER shared with money queries — it only ever runs the advisory-lock + fence SQL
 * below.]
 *
 * The lock is bound to TCP-session liveness, so on a hard leader death Postgres
 * releases it server-side once the broken session is torn down — no TTL-vs-GC-pause
 * race. We set aggressive TCP keepalives so that teardown is ~3s, not the OS default
 * of minutes, which (with the follower poll) is how we hit the <5s failover SLA.
 *
 * ADDITIVE/UNWIRED in 4.5a: nothing constructs this in the running app yet.
 */
export class PgAdvisoryLock implements LeaderLock {
  private readonly log = new Logger(PgAdvisoryLock.name);
  private client: Client | null = null;

  /**
   * Fixed advisory-lock key. Derived once as `hashtext('vaultrun:engine:leader')`
   * (= -787710970 on this PG) and HARDCODED so every node races on the SAME key
   * deterministically, independent of any per-call hashtext evaluation.
   */
  static readonly LEADER_KEY = -787710970n;
  private static readonly REDIS_LEASE_KEY = "vaultrun:leader";
  private static readonly LEASE_PX = 3000; // advisory mirror TTL (Postgres is authority)

  constructor(
    private readonly databaseUrl: string,
    private readonly nodeId: string,
    private readonly redis?: Redis, // optional advisory lease mirror; null = Postgres-only
  ) {}

  /** Lazily open the dedicated connection. */
  private async conn(): Promise<Client> {
    if (this.client) return this.client;
    const c = new Client({
      connectionString: stripPrismaParams(this.databaseUrl),
      // Enable TCP keepalives. node-postgres only forwards keepAlive + the initial idle
      // delay (the probe interval/count fall to OS defaults), so fast dead-leader
      // detection does NOT rely on fine-grained keepalive timing — it comes from the
      // ElectionService heartbeat (SELECT 1 every ~1s; a dead session throws → demote)
      // plus connectionTimeoutMillis bounding reconnect. On a hard leader death Postgres
      // then releases the advisory lock and a follower acquires within the failover budget
      // (measured for real in the 4.5b/4.5c chaos drill).
      keepAlive: true,
      keepAliveInitialDelayMillis: 1000,
      // Bound the initial connect so a dead DB at acquire-time fails fast, not hangs.
      connectionTimeoutMillis: 3000,
      application_name: `vaultrun-engine-election-${this.nodeId.slice(0, 8)}`,
    });
    c.on("error", (e) => this.log.warn(`leader-conn error: ${e.message}`)); // never throw out-of-band
    await c.connect();
    this.client = c;
    return c;
  }

  async tryAcquire(): Promise<bigint | null> {
    const c = await this.conn();
    const got = await c.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
      PgAdvisoryLock.LEADER_KEY.toString(),
    ]);
    if (!got.rows[0]?.locked) return null; // another live session holds it → stay follower
    // Won the lock → bump the monotonic fence (Belt B) in the SAME session. The seeded
    // singleton row (migration) guarantees this UPDATE always matches a row.
    const bumped = await c.query<{ fence: string }>(
      "UPDATE engine_leadership SET fence = fence + 1, node_id = $1, acquired_at = now() WHERE id = true RETURNING fence",
      [this.nodeId],
    );
    const fence = BigInt(bumped.rows[0]!.fence);
    await this.writeLease(fence); // advisory mirror for fast follower reads
    return fence;
  }

  async heartbeat(): Promise<void> {
    // No client yet means we never acquired — treat as a liveness failure so the caller
    // demotes rather than silently believing it leads.
    if (!this.client) throw new Error("heartbeat: no leader connection");
    // `SELECT 1` on the dedicated session: throws if the connection died (we lost the
    // lock) → caller demotes. A merely SLOW (not dead) connection does not throw, so we
    // never false-step-down on latency. We re-read the fence cheaply and re-mirror it.
    await this.client.query("SELECT 1");
    const fence = await this.currentFence();
    await this.writeLease(fence);
  }

  async currentFence(): Promise<bigint> {
    const c = await this.conn();
    const r = await c.query<{ fence: string }>("SELECT fence FROM engine_leadership WHERE id = true");
    return BigInt(r.rows[0]?.fence ?? "0");
  }

  async release(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.query("SELECT pg_advisory_unlock($1)", [PgAdvisoryLock.LEADER_KEY.toString()]);
    } catch (e: any) {
      this.log.warn(`advisory unlock failed (connection likely already dead): ${e?.message}`);
    }
    await this.clearLease();
  }

  async close(): Promise<void> {
    try {
      await this.client?.end();
    } catch {
      /* best-effort */
    }
    this.client = null;
  }

  // ---- Redis advisory lease mirror (design §1; Postgres remains the authority) ----
  private async writeLease(fence: bigint): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(
        PgAdvisoryLock.REDIS_LEASE_KEY,
        `${this.nodeId}:${fence}`,
        "PX",
        PgAdvisoryLock.LEASE_PX,
      );
    } catch {
      /* lease is advisory-only — never fail leadership on a Redis blip */
    }
  }

  private async clearLease(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(PgAdvisoryLock.REDIS_LEASE_KEY);
    } catch {
      /* advisory-only */
    }
  }
}

/**
 * `pg` does not understand Prisma-only query params (`?schema=public`,
 * `connection_limit`, `pgbouncer`, …). Strip them so the dedicated client connects.
 * `schema=public` is the default search_path anyway; for any non-public schema the
 * fence SQL is fully schema-qualified-safe via search_path set on the role if needed.
 */
export function stripPrismaParams(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ["schema", "connection_limit", "pgbouncer", "pool_timeout", "connect_timeout"]) {
      u.searchParams.delete(k);
    }
    // NB: rebuild from components, NOT `u.origin` — for the non-"special" `postgresql:`
    // scheme the WHATWG URL parser returns origin === "null", which would corrupt the
    // host (the cause of a getaddrinfo ENOTFOUND on a "null/db" string).
    const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ""}@` : "";
    const qs = u.searchParams.toString();
    return `${u.protocol}//${auth}${u.host}${u.pathname}${qs ? `?${qs}` : ""}`;
  } catch {
    return url; // not a parseable URL — hand it to pg as-is
  }
}
