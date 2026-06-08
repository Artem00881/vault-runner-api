/**
 * Phase 4.5a — the leadership-lock seam.
 *
 * `LeaderLock` is the testability interface (Phase 4 design §6a): `ElectionService`
 * depends only on this, so unit tests inject an in-memory stub and never need a real
 * second Postgres connection. The production implementation is `PgAdvisoryLock` below.
 *
 * Authority model (design §1): a Postgres SESSION advisory lock on a DEDICATED,
 * long-lived connection is the source of truth for "who is the engine leader". The
 * lock is bound to TCP-session liveness, not a wall-clock TTL, so there is no
 * TTL-vs-GC-pause race the way a pure Redis lease has. A monotonic FENCE (Belt B,
 * `engine_leadership`) is bumped on every acquire so a stale leader can be detected
 * and fenced off before any write. Redis carries an advisory-only MIRROR of the
 * lease (fast follower reads); Postgres always wins on disagreement.
 *
 * These primitives shipped ADDITIVE in 4.5a and are WIRED LIVE since 4.5b: the engine
 * subscribes to ElectionService and drives start()/stop() off leadership
 * (game-engine.service.ts onModuleInit). On the single-node prod deploy one node wins the
 * lock on boot and runs the loop; the election machinery is what makes a multi-node
 * failover seamless.
 */
export interface LeaderLock {
  /**
   * Attempt to become leader. On success: takes the Postgres advisory lock AND bumps
   * the fence (returns the NEW fence so the caller can cache `myFence`). On failure
   * (another live session holds the lock): returns null, no fence change.
   */
  tryAcquire(): Promise<bigint | null>;

  /**
   * Liveness check on the dedicated leader connection. Resolves if the session is
   * still alive (we still hold the lock); THROWS if the connection died (we have lost
   * leadership and the caller must demote). Also refreshes the Redis lease mirror.
   */
  heartbeat(): Promise<void>;

  /** Read the current authoritative fence (for `assertStillLeader()` stale checks). */
  currentFence(): Promise<bigint>;

  /** Release the advisory lock + clear the lease mirror (clean shutdown / step-down). */
  release(): Promise<void>;

  /** Tear down the dedicated connection(s). */
  close(): Promise<void>;
}
