-- Widen the Bet debit/payout transaction-id columns from uuid to text.
-- In operator wallet mode these hold the OPERATOR's transaction id
-- (OperatorWalletResponse.operatorTxId), which is an arbitrary string, not a uuid —
-- so the uuid columns rejected operator-mode placeBet/cashOut writes (22P02 /
-- Prisma P2023). The cast is lossless: every existing value is a uuid the internal
-- ledger produced, and uuid casts to text implicitly. Operator-hardening / audit Finding 2.

-- AlterTable
ALTER TABLE "game_bets" ALTER COLUMN "debit_tx_id" SET DATA TYPE TEXT,
ALTER COLUMN "payout_tx_id" SET DATA TYPE TEXT;
