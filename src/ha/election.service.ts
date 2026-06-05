import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { LeaderLock } from "./leader-lock";

/**
 * Phase 4.5a — leader election PRIMITIVE for the single shared engine.
 *
 * Authoritative leadership = a Postgres session advisory lock on a dedicated
 * connection (the injected `LeaderLock`, real impl `PgAdvisoryLock`). This service
 * owns the lifecycle: poll-to-acquire while a follower, heartbeat while a leader,
 * demote on a dead connection, bump a monotonic fence on each acquire (Belt B), and
 * expose `isLeader()` / `fence` / `assertStillLeader()` plus `leader-acquired` /
 * `leader-lost` events for the engine wiring in 4.5b.
 *
 * 4.5a SCOPE — ADDITIVE & UNWIRED: this service is NOT registered in AppModule (see
 * HaModule, which is intentionally not imported), and it does NOT call
 * engine.start()/stop(). It only arbitrates + emits; 4.5b consumes the events. The
 * running single-node game is byte-for-byte unchanged.
 *
 * `GAME_AUTOSTART=false` ⇒ NEVER participate in election (pure follower / WS-only
 * node forever) — the same hard override the engine uses today, and what tests rely on.
 */

export const ACQUIRE_INTERVAL_MS = 2000; // follower poll cadence (design §1; tighten to 1000 if failover too close to 5s)
export const HEARTBEAT_INTERVAL_MS = 1000; // leader liveness cadence

export type ElectionEvent = "leader-acquired" | "leader-lost";

@Injectable()
export class ElectionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ElectionService.name);
  /** `leader-acquired` (fence:bigint) / `leader-lost` () for the engine wiring (4.5b). */
  readonly events = new EventEmitter();

  /** Stable identity for this process across logs + the fence row + the Redis lease. */
  readonly nodeId: string;

  private leader = false;
  private myFence: bigint | null = null;
  private acquireTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** GAME_AUTOSTART=false ⇒ never elect. Captured at construction (matches the engine). */
  private readonly participates: boolean;

  constructor(
    private readonly lock: LeaderLock,
    nodeId?: string,
  ) {
    this.nodeId = nodeId ?? `${process.env.HOSTNAME ?? "node"}-${randomUUID().slice(0, 8)}`;
    this.participates = process.env.GAME_AUTOSTART !== "false";
  }

  // ---- lifecycle ----
  async onModuleInit() {
    if (!this.participates) {
      this.log.log(`election: GAME_AUTOSTART=false → pure follower (never acquires) [node=${this.nodeId}]`);
      return;
    }
    this.log.log(`election: eligible — polling for leadership every ${ACQUIRE_INTERVAL_MS}ms [node=${this.nodeId}]`);
    // Attempt immediately so a single node leads instantly on boot (no first-poll delay),
    // then poll on the interval while a follower.
    await this.tick().catch((e) => this.log.error(`initial acquire failed: ${e?.message}`));
    this.acquireTimer = setInterval(() => void this.tick(), ACQUIRE_INTERVAL_MS);
    // Don't keep the event loop alive solely for the timer (clean test/process exit).
    this.acquireTimer.unref?.();
  }

  async onModuleDestroy() {
    this.stopped = true;
    this.clearTimers();
    if (this.leader) {
      this.leader = false;
      try {
        await this.lock.release();
      } catch (e: any) {
        this.log.warn(`release on shutdown failed: ${e?.message}`);
      }
    }
    await this.lock.close().catch(() => undefined);
  }

  // ---- public reads (consumed by 4.5b engine wiring + followers) ----
  isLeader(): boolean {
    return this.leader;
  }

  /** The fence cached when we last acquired (null if never leader). */
  get fence(): bigint | null {
    return this.myFence;
  }

  /**
   * Stale-leader guard (design §2 Belt B): true only if we still hold the CURRENT
   * fence. A second node that acquired after us bumped the fence past `myFence`, so a
   * stale leader's pending phase transition sees this go false and must self-demote
   * BEFORE any engine-authored write. Cheap (one indexed singleton read) — called at
   * the top of each phase transition in 4.5b. Fails CLOSED (returns false) on error.
   */
  async assertStillLeader(): Promise<boolean> {
    if (!this.leader || this.myFence === null) return false;
    try {
      const current = await this.lock.currentFence();
      if (current !== this.myFence) {
        this.log.warn(`stale leader: fence advanced ${this.myFence} → ${current} — no longer authoritative`);
        return false;
      }
      return true;
    } catch (e: any) {
      this.log.warn(`assertStillLeader fence read failed (fail-closed): ${e?.message}`);
      return false;
    }
  }

  // ---- election mechanics (driven directly by tests; no real timers needed) ----

  /** One follower poll: try to acquire; promote on success. No-op once leader. */
  async tick(): Promise<void> {
    if (this.stopped || this.leader) return;
    let fence: bigint | null;
    try {
      fence = await this.lock.tryAcquire();
    } catch (e: any) {
      // A DB blip at acquire-time: stay follower, retry next poll. Never promote on error.
      this.log.warn(`acquire attempt failed: ${e?.message}`);
      return;
    }
    if (fence === null) return; // someone else leads — stay follower
    this.promote(fence);
  }

  private promote(fence: bigint) {
    this.leader = true;
    this.myFence = fence;
    this.log.log(`acquired leadership (fence=${fence}) [node=${this.nodeId}]`);
    // Switch from acquire-polling to heartbeat. (4.5b: the engine resume+start hangs
    // off the 'leader-acquired' listener; 4.5a only emits.)
    this.clearAcquireTimer();
    if (!this.stopped) {
      this.heartbeatTimer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimer.unref?.();
    }
    this.events.emit("leader-acquired", fence);
  }

  /** One leader heartbeat: liveness-check the dedicated connection; demote on death. */
  async beat(): Promise<void> {
    if (this.stopped || !this.leader) return;
    try {
      await this.lock.heartbeat();
    } catch (e: any) {
      // The dedicated connection died → we have LOST the advisory lock (another node may
      // already be acquiring). Demote immediately, before the next phase transition.
      this.log.error(`heartbeat failed → demoting from leader: ${e?.message}`);
      this.demote();
    }
  }

  private demote() {
    if (!this.leader) return;
    this.leader = false;
    this.myFence = null;
    this.clearHeartbeatTimer();
    this.events.emit("leader-lost");
    // Tear down the dead connection so the next acquire opens a fresh one, then resume
    // polling to (re)acquire if the lock frees up again.
    void this.lock.close().catch(() => undefined);
    if (!this.stopped) {
      this.acquireTimer = setInterval(() => void this.tick(), ACQUIRE_INTERVAL_MS);
      this.acquireTimer.unref?.();
    }
  }

  // ---- timer hygiene ----
  private clearAcquireTimer() {
    if (this.acquireTimer) {
      clearInterval(this.acquireTimer);
      this.acquireTimer = null;
    }
  }
  private clearHeartbeatTimer() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  private clearTimers() {
    this.clearAcquireTimer();
    this.clearHeartbeatTimer();
  }
}
