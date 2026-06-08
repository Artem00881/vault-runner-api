-- Audit fix F-058 — unified significant-event AUDIT LOG (ADDITIVE, forward-only).
-- A standalone, APPEND-ONLY record of operator / config / key / void / session-revoke
-- / RNG events: the "who did what, when" trail GLI-19 expects alongside the money
-- ledger (ledger_transactions) and the provably-fair seed chain. DELIBERATELY has NO
-- foreign key — the ids (operator_id / target_id) are denormalised, the way game_bets
-- carries a bare operator_id — so nothing can CASCADE a row away.
--
-- APPEND-ONLY: the application only ever INSERTs into this table (AuditEventService
-- exposes no update/delete). To make immutability ENFORCED rather than merely assumed,
-- prod should REVOKE UPDATE, DELETE ON "audit_events" FROM the app DB role (ops
-- follow-up — see DEPLOY.md). This migration creates the table + its indexes ONLY;
-- it contains no destructive statement.

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "operator_id" UUID,
    "ip" TEXT,
    "before" JSONB,
    "after" JSONB,
    "meta" JSONB,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_created_at_idx" ON "audit_events"("created_at");

-- CreateIndex
CREATE INDEX "audit_events_operator_id_created_at_idx" ON "audit_events"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_action_created_at_idx" ON "audit_events"("action", "created_at");

-- F-058: enforce append-only at the DB level (role-independent — survives even a
-- compromised app credential). The app NEVER updates/deletes audit_events; this
-- trigger makes it a hard guarantee a certification lab can verify. A bare REVOKE
-- would be a no-op under the current single-role deploy, so the guarantee lives in
-- a trigger instead. Safe for the test/soak harnesses: nothing in the suite ever
-- mutates/deletes audit_events (scoped deleteMany only touches play tables), and
-- load/recon-soak.ts TRUNCATEs only ledger_transactions/game_bets/game_rounds — so
-- no cleanup path is blocked by these triggers.
CREATE OR REPLACE FUNCTION "audit_events_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% is forbidden)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_no_update" BEFORE UPDATE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_immutable"();
CREATE TRIGGER "audit_events_no_delete" BEFORE DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_immutable"();
CREATE TRIGGER "audit_events_no_truncate" BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_immutable"();
