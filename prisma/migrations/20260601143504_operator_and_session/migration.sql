-- CreateTable
CREATE TABLE "operators" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "launch_secret" TEXT NOT NULL,
    "currencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wallet_api_url" TEXT,
    "wallet_api_key" TEXT,
    "callback_url" TEXT,
    "ip_whitelist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bet_limits" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_sessions" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "player_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "wallet_id" UUID NOT NULL,
    "launch_jti" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "game_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operators_code_key" ON "operators"("code");

-- CreateIndex
CREATE UNIQUE INDEX "game_sessions_launch_jti_key" ON "game_sessions"("launch_jti");

-- CreateIndex
CREATE INDEX "game_sessions_operator_id_player_id_idx" ON "game_sessions"("operator_id", "player_id");

-- AddForeignKey
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
