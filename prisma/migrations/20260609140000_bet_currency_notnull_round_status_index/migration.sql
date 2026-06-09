-- F-084: harden Bet.currency to NOT NULL. Every live insert already stamps the wallet's
-- canonical (UPPERCASE) currency (bets.service.ts), so a null can only be a legacy pre-
-- denormalisation row. Backfill those from their wallet, then add the constraint. Forward-only,
-- additive integrity tightening (no schema default — the code must always supply it, fail-loud).
UPDATE "game_bets" b
  SET "currency" = UPPER(w."currency")
  FROM "wallets" w
  WHERE b."wallet_id" = w."id" AND b."currency" IS NULL;

-- Defensive fallback for any orphan the FK (RESTRICT, F-017) should make impossible — so the
-- SET NOT NULL below can never fail on a stray null.
UPDATE "game_bets" SET "currency" = 'DEMO' WHERE "currency" IS NULL;

-- AlterColumn
ALTER TABLE "game_bets" ALTER COLUMN "currency" SET NOT NULL;

-- F-021: index the engine hot-path per-round bet reads (`WHERE round_id = ? AND status IN (...)`
-- in placeBet's exposure read and the settlement/recovery sweeps) — more selective than the
-- round-prefix of the (round_id,user_id,panel) unique plus the standalone status index.
-- CreateIndex
CREATE INDEX "game_bets_round_id_status_idx" ON "game_bets"("round_id", "status");
