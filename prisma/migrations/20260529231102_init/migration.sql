-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "is_guest" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'DEMO',
    "balance" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "ref_type" TEXT,
    "ref_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fairness_seeds" (
    "id" UUID NOT NULL,
    "chain_index" INTEGER NOT NULL,
    "seed_hash" TEXT NOT NULL,
    "seed" TEXT,
    "salt" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revealed_at" TIMESTAMPTZ(6),

    CONSTRAINT "fairness_seeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_rounds" (
    "id" UUID NOT NULL,
    "seed_id" UUID NOT NULL,
    "nonce" BIGINT NOT NULL,
    "crash_point" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'betting',
    "betting_opens_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "crashed_at" TIMESTAMPTZ(6),
    "settled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_bets" (
    "id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "panel" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "auto_cashout" DECIMAL(10,2),
    "status" TEXT NOT NULL DEFAULT 'active',
    "cashout_mult" DECIMAL(10,2),
    "payout" BIGINT NOT NULL DEFAULT 0,
    "debit_tx_id" UUID,
    "payout_tx_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "game_bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "user_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "biggest_multiplier" DECIMAL(10,2) NOT NULL DEFAULT 1.00,
    "total_loot" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_currency_key" ON "wallets"("user_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_idempotency_key_key" ON "ledger_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_transactions_wallet_id_created_at_idx" ON "ledger_transactions"("wallet_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "fairness_seeds_chain_index_key" ON "fairness_seeds"("chain_index");

-- CreateIndex
CREATE INDEX "game_rounds_created_at_idx" ON "game_rounds"("created_at" DESC);

-- CreateIndex
CREATE INDEX "game_bets_user_id_created_at_idx" ON "game_bets"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "game_bets_round_id_user_id_panel_key" ON "game_bets"("round_id", "user_id", "panel");

-- CreateIndex
CREATE INDEX "profiles_biggest_multiplier_total_loot_idx" ON "profiles"("biggest_multiplier" DESC, "total_loot" DESC);

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_rounds" ADD CONSTRAINT "game_rounds_seed_id_fkey" FOREIGN KEY ("seed_id") REFERENCES "fairness_seeds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_bets" ADD CONSTRAINT "game_bets_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "game_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_bets" ADD CONSTRAINT "game_bets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_bets" ADD CONSTRAINT "game_bets_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
