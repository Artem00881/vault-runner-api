-- AlterTable
ALTER TABLE "operators" ADD COLUMN     "rg_config" JSONB;

-- CreateIndex
CREATE INDEX "game_bets_wallet_id_created_at_idx" ON "game_bets"("wallet_id", "created_at");
