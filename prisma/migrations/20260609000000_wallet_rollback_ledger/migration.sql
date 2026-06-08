-- Audit fix M1 — operator-wallet ROLLBACK LEDGER (ADDITIVE, forward-only).
-- One row per LOGICAL reversal we ever need to apply at the operator: the
-- ambiguous/transient debit compensation (F-002) and the void reclaim/refund legs.
-- Three jobs in one table:
--   * F-002 (once-only marker): the UNIQUE(operator_id, dedupe_key) makes a rollback
--     emit idempotent ON OUR SIDE — a `confirmed` row means "already rolled back, do NOT
--     re-emit", so a void resume / retry cannot double-reverse even against an operator
--     whose repeat-rollback is NOT idempotent. The once-only identity is the LOGICAL
--     reversal "undo {reason} for {bet}" (dedupe_key = `{betId|transactionId}#{reason}`),
--     NOT the raw operator transaction_id — which is REUSABLE: the debit key
--     `bet:{round}:{user}:{panel}:debit` is reused by a re-bet on the same slot, so keying
--     once-only on transaction_id would let a confirmed ambiguous_debit on one bet WRONGLY
--     suppress a genuinely-different void_refund (or another bet's compensation) on the
--     same key, stranding a live bet's stake. The intent+bet-distinct dedupe_key fixes both
--     cross-INTENT and same-reason-different-BET conflation.
--   * F-027 (durable outbox): a row left `pending` (the operator rollback call failed) is
--     the persisted owed-rollback the periodic drain (game.gateway reserving sweep) re-emits
--     until it confirms — the discrepancy is never lost. The drain re-emits using the STORED
--     `transaction_id` (the operator reverses by the ORIGINAL key — that is unchanged).
--   * #2 claim/drain atomicity: the drain CASes a pending row → `draining` with a
--     `lease_until` BEFORE the operator emit, so a concurrent live-void resume sees the
--     in-flight row and does NOT also emit (sweep-vs-live-void double-reverse guard). A
--     crashed drain's stale `draining` lease is reclaimed by the next pass.
--
-- DELIBERATELY has NO foreign key — operator_id / bet_id are denormalised, the way game_bets
-- carries a bare operator_id and audit_events carries a bare operator_id — so nothing can
-- CASCADE a row away.
--
-- NOT append-only (UNLIKE audit_events): a row legitimately transitions
-- pending → draining → confirmed (status / attempts / last_error / resolved_at / lease_until
-- are UPDATEd), so there is intentionally NO immutability trigger here. The test/soak
-- teardown scoped-deletes only its own rows. This migration creates the table + its two
-- indexes ONLY; it contains no destructive statement.

-- CreateTable
CREATE TABLE "wallet_rollbacks" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "player_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    -- The ORIGINAL operator transaction being reversed (the key the operator dedups on). NOT
    -- the once-only key (it is reusable) — kept as a plain column; the drain re-emits with it.
    "transaction_id" TEXT NOT NULL,
    -- The LOGICAL-reversal once-only identity = `{bet_id|transaction_id}#{reason}`. Intent-
    -- and-bet-distinct so cross-intent / same-reason-different-bet reversals never conflate.
    "dedupe_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL, -- ambiguous_debit | transient_debit | void_reclaim | void_refund
    "bet_id" UUID,
    "amount" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'pending', -- pending | draining | confirmed
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    -- #2: while a row is `draining`, the owning drain holds it until this instant; a stale
    -- lease (crashed drain) is reclaimable by the next pass. NULL when not draining.
    "lease_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "wallet_rollbacks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- F-002 once-only key: at most one rollback row per operator per LOGICAL reversal. The
-- service upserts on this and treats an existing `confirmed` row as "skip the operator emit".
CREATE UNIQUE INDEX "wallet_rollbacks_operator_id_dedupe_key_key" ON "wallet_rollbacks"("operator_id", "dedupe_key");

-- CreateIndex
-- F-027 drain scan: pending/draining rows oldest-first.
CREATE INDEX "wallet_rollbacks_status_created_at_idx" ON "wallet_rollbacks"("status", "created_at");
