-- Phase 4.3 perf: index the status columns so the recovery/sweep/reconcile/backlog
-- queries that filter on the (rare) open/transient statuses are index-served
-- instead of sequential scans as the round/bet tables grow. Additive, no data
-- change, forward-only.

-- CreateIndex
CREATE INDEX "game_rounds_status_idx" ON "game_rounds"("status");

-- CreateIndex
CREATE INDEX "game_bets_status_idx" ON "game_bets"("status");
