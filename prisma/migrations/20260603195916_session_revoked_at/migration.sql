-- Soft session revocation (L-C2.2 trigger). A non-NULL revoked_at marks a session dead:
-- GameSessionService.isLive() rejects it at WS connect, but the row is KEPT so the
-- operator-wallet resolver still routes in-flight settlement for that wallet. Nullable +
-- additive; every existing session backfills to NULL (= live).

-- AlterTable
ALTER TABLE "game_sessions" ADD COLUMN     "revoked_at" TIMESTAMPTZ(6);
