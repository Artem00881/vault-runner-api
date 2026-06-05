-- Phase 4.5a — engine HA split-brain belts (ADDITIVE, forward-only; NOT yet wired
-- to the engine — no behavior change to the running game). Two safety belts + an
-- optional forensics column, so a transient double-leader can never double-mint a
-- round and a stale leader can be fenced off before any engine-authored write.
--
-- Belt A pre-checked safe on the dev DB: 2253 rounds = 2253 distinct seed_ids,
-- 0 duplicates (the invariant already holds — allocateSeed filters
-- rounds: { none: {} }). This makes it DB-enforced rather than merely assumed.

-- Belt A — UNIQUE(seed_id) on game_rounds: a seed serves exactly one round, forever.
-- A second leader's round.create on the same seed now hits a unique violation (P2002).
-- CreateIndex
CREATE UNIQUE INDEX "game_rounds_seed_id_key" ON "game_rounds"("seed_id");

-- Optional forensics / soft-phase cold-start (Phase 4 §4): per-phase soft deadline,
-- additive-nullable, written by the engine in 4.5b. NOT money/fairness-critical —
-- the crash time is derived from started_at + crash_point + GROWTH.
-- AlterTable
ALTER TABLE "game_rounds" ADD COLUMN "phase_ends_at" TIMESTAMPTZ(6);

-- Belt B — singleton engine-leadership fence table. Postgres advisory lock is the
-- leadership authority (see ElectionService); this row carries the monotonic fencing
-- token a stale leader checks before any write.
-- CreateTable
CREATE TABLE "engine_leadership" (
    "id" BOOLEAN NOT NULL DEFAULT true,
    "fence" BIGINT NOT NULL DEFAULT 0,
    "node_id" TEXT,
    "acquired_at" TIMESTAMPTZ(6),

    CONSTRAINT "engine_leadership_pkey" PRIMARY KEY ("id")
);

-- Seed the single row so an acquire's UPDATE ... SET fence = fence + 1 always has a
-- row to bump. Idempotent (ON CONFLICT DO NOTHING) — safe under a re-run / crash-loop.
INSERT INTO "engine_leadership" ("id", "fence") VALUES (true, 0) ON CONFLICT ("id") DO NOTHING;
