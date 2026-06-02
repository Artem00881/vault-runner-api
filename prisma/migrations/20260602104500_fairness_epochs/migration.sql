-- Fairness epochs. A seed chain becomes one of many "epochs", each its own
-- provably-fair chain with its own public commit and salt. Enables seamless
-- chain rollover (no more exhaustion stalls) and per-epoch salt sources
-- (random today, blockchain block-hash later). The salt moves from each seed
-- onto its chain (epoch).

-- CreateTable
CREATE TABLE "fairness_chains" (
    "id" UUID NOT NULL,
    "epoch" INTEGER NOT NULL,
    "commit_hash" TEXT NOT NULL,
    "length" INTEGER NOT NULL,
    "salt_source" TEXT NOT NULL DEFAULT 'random',
    "target_chain" TEXT,
    "target_block" BIGINT,
    "salt" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "armed_at" TIMESTAMPTZ(6),

    CONSTRAINT "fairness_chains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fairness_chains_epoch_key" ON "fairness_chains"("epoch");

-- Add chain_id to fairness_seeds (nullable first, so existing rows can be backfilled).
ALTER TABLE "fairness_seeds" ADD COLUMN "chain_id" UUID;

-- Data migration: fold any pre-existing single chain into epoch 0 and link its
-- seeds to it. No-op on a fresh database. (gen_random_uuid is core in PG 13+.)
DO $$
DECLARE
  v_chain_id UUID := gen_random_uuid();
  v_commit   TEXT;
  v_salt     TEXT;
  v_count    INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM "fairness_seeds";
  IF v_count > 0 THEN
    SELECT "seed" INTO v_commit FROM "fairness_seeds" WHERE "chain_index" = 0 LIMIT 1;
    SELECT "salt" INTO v_salt   FROM "fairness_seeds" WHERE "salt" IS NOT NULL LIMIT 1;
    INSERT INTO "fairness_chains"
      ("id","epoch","commit_hash","length","salt_source","salt","status","created_at","armed_at")
    VALUES
      (v_chain_id, 0, COALESCE(v_commit, ''), v_count, 'random', v_salt, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    UPDATE "fairness_seeds" SET "chain_id" = v_chain_id WHERE "chain_id" IS NULL;
  END IF;
END $$;

-- Now enforce NOT NULL (all existing rows are backfilled; fresh tables are empty).
ALTER TABLE "fairness_seeds" ALTER COLUMN "chain_id" SET NOT NULL;

-- Replace the global chain_index unique with a per-chain unique (epoch resets the index).
DROP INDEX IF EXISTS "fairness_seeds_chain_index_key";
CREATE UNIQUE INDEX "fairness_seeds_chain_id_chain_index_key" ON "fairness_seeds"("chain_id", "chain_index");

-- AddForeignKey
ALTER TABLE "fairness_seeds"
  ADD CONSTRAINT "fairness_seeds_chain_id_fkey"
  FOREIGN KEY ("chain_id") REFERENCES "fairness_chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Salt now lives on the chain (epoch), not on each seed.
ALTER TABLE "fairness_seeds" DROP COLUMN "salt";
