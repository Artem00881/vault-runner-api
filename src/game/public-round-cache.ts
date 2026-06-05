import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Inject } from "@nestjs/common";
import type Redis from "ioredis";
import { RedisService } from "../redis/redis.service";
import { GROWTH, type Phase, type PublicRoundState } from "./round-types";

/**
 * Phase 4.5b — the FOLLOWER public-state mirror (design §3).
 *
 * The engine leader publishes the PUBLIC round state (the exact `getPublicState()`
 * shape, which deliberately excludes `crashPoint`) on the Redis pub/sub channel
 * `vaultrun:round` PLUS `startedAt` + `seedId`, and keeps writing the `round:current`
 * snapshot key. This cache subscribes to that channel (on a dedicated `redis.duplicate()`
 * connection — a subscriber can't run normal commands) and seeds from `round:current` on
 * boot, so a node that booted mid-round has state immediately.
 *
 * STRUCTURAL crash-safety: `PublicRoundView` has NO `crashPoint` field — it is
 * impossible for a follower to hold or leak the secret crash. A follower computes only
 * the CURRENT running multiplier locally from `startedAt + GROWTH + now` (exactly what a
 * player already sees on screen) and, post-crash, serves the multiplier the leader
 * published (which equals the now-revealed crashPoint — already public at that point).
 *
 * This is what makes a manual cash-out on a FOLLOWER node return the correct multiplier
 * (the bug was: with no engine loop, `engine.currentMultiplier()` returned 1.0). The
 * money move itself is unchanged — `cashOut` still uses the existing advisory-lock + CAS
 * + idempotent-credit path; only what `engine.currentMultiplier()`/`getPublicState()`
 * RETURN on a follower changes.
 */

/** The follower-side mirror of one round. STRUCTURALLY no `crashPoint` field. */
export interface PublicRoundView {
  roundId: string;
  phase: Phase;
  phaseEndsAt: number;
  /** epoch ms the running phase began (null pre-running) — the anchor for the local multiplier. */
  startedAt: number | null;
  seedId: string;
  /** the multiplier the leader last published (authoritative for crashed/settling/completed). */
  multiplier: number;
  /** the leader's serverTime at publish (for staleness/observability). */
  serverTime: number;
}

/** The wire payload the leader publishes — public state + startedAt + seedId, NEVER crashPoint. */
export interface PublishedRoundState extends PublicRoundState {
  startedAt: number | null;
  seedId: string;
}

export const ROUND_CHANNEL = "vaultrun:round";
export const ROUND_SNAPSHOT_KEY = "round:current";

@Injectable()
export class PublicRoundCache implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PublicRoundCache.name);
  private sub: Redis | null = null;
  private view: PublicRoundView | null = null;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async onModuleInit() {
    // Seed from the snapshot so a node that booted mid-round has state immediately,
    // then subscribe for live updates. Both are best-effort: with no Redis the cache
    // simply stays empty and getView() returns null (the leader path is unaffected).
    try {
      const snap = await this.redis.client.get(ROUND_SNAPSHOT_KEY);
      if (snap) this.ingest(snap);
    } catch (e: any) {
      this.log.warn(`seed from ${ROUND_SNAPSHOT_KEY} failed: ${e?.message}`);
    }
    try {
      this.sub = this.redis.duplicate();
      this.sub.on("error", (e) => this.log.warn(`round-sub: ${e.message}`));
      this.sub.on("message", (_ch, msg) => this.ingest(msg));
      await this.sub.subscribe(ROUND_CHANNEL);
    } catch (e: any) {
      this.log.warn(`subscribe to ${ROUND_CHANNEL} failed (follower reads will be stale): ${e?.message}`);
    }
  }

  async onModuleDestroy() {
    try {
      await this.sub?.quit();
    } catch {
      /* best-effort */
    }
    this.sub = null;
  }

  /** Parse a published payload into the crashPoint-free view. Tolerant of malformed input. */
  private ingest(raw: string) {
    try {
      const p = JSON.parse(raw) as Partial<PublishedRoundState>;
      if (!p || typeof p.roundId !== "string" || typeof p.phase !== "string") return;
      // Build the view field-by-field — NEVER spread the payload, so even a (malicious or
      // buggy) publish carrying a `crashPoint` key cannot land in the follower view.
      this.view = {
        roundId: p.roundId,
        phase: p.phase as Phase,
        phaseEndsAt: Number(p.phaseEndsAt ?? 0),
        startedAt: p.startedAt === null || p.startedAt === undefined ? null : Number(p.startedAt),
        seedId: typeof p.seedId === "string" ? p.seedId : "",
        multiplier: Number(p.multiplier ?? 1),
        serverTime: Number(p.serverTime ?? Date.now()),
      };
    } catch {
      /* ignore a malformed message — keep the last good view */
    }
  }

  /** Latest mirrored view (null if nothing seen yet). */
  getView(): PublicRoundView | null {
    return this.view;
  }

  /**
   * The follower's `getPublicState()` — the same shape the leader returns, computed from
   * the mirrored view with the live running multiplier recomputed locally.
   */
  getPublicState(): PublicRoundState | null {
    const v = this.view;
    if (!v) return null;
    return {
      roundId: v.roundId,
      phase: v.phase,
      phaseEndsAt: v.phaseEndsAt,
      multiplier: this.currentMultiplier(),
      serverTime: Date.now(),
    };
  }

  /**
   * The follower's live multiplier. Pre-running → 1.0; running → recompute locally from
   * the leader-published `startedAt` (the EXACT formula from the engine); crashed/
   * settling/completed → the leader-published value (= the revealed crashPoint, already
   * public). A follower NEVER computes the pre-crash crashPoint — it only ever extends the
   * public climbing curve up to whatever the published phase allows.
   */
  currentMultiplier(): number {
    const v = this.view;
    if (!v) return 1.0;
    if (v.phase === "crashed" || v.phase === "settling" || v.phase === "completed") {
      return v.multiplier;
    }
    if (v.phase === "running" && v.startedAt) {
      const m = Math.exp(GROWTH * (Date.now() - v.startedAt));
      return Math.max(1.0, Math.floor(m * 100) / 100);
    }
    return 1.0;
  }
}
