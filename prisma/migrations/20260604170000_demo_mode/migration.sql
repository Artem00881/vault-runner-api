-- AlterTable
ALTER TABLE "operators" ADD COLUMN     "demo_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "game_sessions" ADD COLUMN     "demo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "game_bets" ADD COLUMN     "demo" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "game_sessions_wallet_id_idx" ON "game_sessions"("wallet_id");
