-- Audit fix M3 (F-067) — PERSIST reality-check state on game_sessions (ADDITIVE, forward-only).
-- The Phase-3 reality-check hard-pause lived ONLY in per-socket memory (client.data.rgPending),
-- so a player could dodge a pending reality check (and reset its clock) by reconnecting. These
-- three nullable columns persist the check's state on the session so the hard-pause SURVIVES a
-- reconnect and the due time is NOT reset to a fresh full interval on every reconnect:
--   * reality_check_due_at      — epoch of the next reality check (the persisted clock; reloaded
--                                 at connect so a reconnect resumes the same schedule).
--   * reality_check_pending_at  — set when a check becomes "awaiting ack" (hard-pause); NULL = not
--                                 pending. A reconnect that finds this non-NULL re-arms rgPending,
--                                 so place_bet stays blocked until the player acks.
--   * reality_check_last_ack_at — last time the player acknowledged a reality check (audit trail).
--
-- The session TIME limit is UNCHANGED — it stays derived from the immutable signed-token
-- sessionStartedAt, never from these columns. ADD COLUMN ×3, nullable, no backfill, no default
-- write — back-compat for every existing row (NULL = never pending / never set). No destructive
-- statement; safe for the test/soak harnesses (no trigger, no FK, no data rewrite).

-- AlterTable
ALTER TABLE "game_sessions" ADD COLUMN "reality_check_due_at" TIMESTAMPTZ(6);
ALTER TABLE "game_sessions" ADD COLUMN "reality_check_pending_at" TIMESTAMPTZ(6);
ALTER TABLE "game_sessions" ADD COLUMN "reality_check_last_ack_at" TIMESTAMPTZ(6);
