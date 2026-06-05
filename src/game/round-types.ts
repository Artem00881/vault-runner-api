/**
 * Shared round value-types + the pacing constant. Extracted from game-engine.service so
 * the follower PublicRoundCache (Phase 4.5b) can depend on them WITHOUT importing the
 * engine service — the engine imports the cache, so a back-import would form a runtime
 * require() cycle that left `PublicRoundCache` undefined at decorator-metadata time.
 * These are plain types/consts (no Nest, no I/O) so they're safe to share both ways.
 */

export type Phase = "waiting" | "betting" | "running" | "crashed" | "settling" | "completed";

export const PHASE_MS = {
  waiting: 3000,
  betting: 5000,
  crashed: 2500,
  settling: 500,
  completed: 600,
} as const;

/** multiplier(t) = e^(GROWTH * elapsedMs). Tunes pacing only; not fairness. */
export const GROWTH = 0.00012;

export interface PublicRoundState {
  roundId: string;
  phase: Phase;
  phaseEndsAt: number;
  multiplier: number;
  serverTime: number;
}
