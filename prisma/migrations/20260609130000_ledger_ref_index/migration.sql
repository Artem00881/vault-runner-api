-- F-020: index the ledger reference lookup so the reconcile join
-- (scripts/reconcile-check.ts: `ledger l JOIN game_bets b ON b.id=l.ref_id WHERE
-- l.ref_type='bet'`) and per-bet forensic ref lookups are index-served instead of a
-- sequential scan as ledger_transactions grows. Additive, no data change, forward-only.
-- The hot money path is unaffected (it dedups on the unique idempotency_key).

-- CreateIndex
CREATE INDEX "ledger_transactions_ref_type_ref_id_idx" ON "ledger_transactions"("ref_type", "ref_id");
