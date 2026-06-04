-- AlterTable
ALTER TABLE "game_bets" ADD COLUMN     "operator_id" UUID;
ALTER TABLE "game_bets" ADD COLUMN     "currency" TEXT;

-- CreateIndex
CREATE INDEX "game_bets_operator_id_currency_created_at_idx" ON "game_bets"("operator_id", "currency", "created_at");
