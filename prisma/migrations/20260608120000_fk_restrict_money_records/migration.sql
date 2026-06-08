-- Audit fix F-017 — money-record retention: FK CASCADE → RESTRICT (forward-only).
--
-- Six relations on money-bearing / account tables had `ON DELETE CASCADE`, which meant
-- deleting one User (or Wallet, or Round) silently erased its Wallets, ledger_transactions,
-- bets and profile — destroying the financial journal a GLI-19 lab (and a regulator)
-- expects to be retained. This migration flips those six to `ON DELETE RESTRICT` so a
-- delete that would orphan or erase a money record is REFUSED at the DB level; PII is
-- instead scrubbed IN PLACE (see DataErasureService / F-065) while the ledger + bet graph
-- stay intact. Additive in spirit: it changes only delete-time behaviour, adds no data and
-- drops no row, and is fully reversible by deploying the prior image (no down-migration).
--
-- game_sessions.operator_id is DELIBERATELY left ON DELETE CASCADE: a GameSession is an
-- ephemeral launch record (not a money record), and the original design lets removing an
-- Operator clean up its sessions. The money journal hangs off Wallet/Bet/Ledger, which are
-- now protected; sessions carry no balance.
--
-- VALIDATION LOCK: each DROP+ADD CONSTRAINT briefly takes an ACCESS EXCLUSIVE lock on the
-- table to re-add the FK (Postgres validates the new constraint). On these small money
-- tables this is sub-second; on a large prod table run it in a low-traffic window. The new
-- column add (anonymized_at, nullable, no default) is a metadata-only change (no rewrite).

-- F-017: User-anchored / money-record FKs → RESTRICT (keep ON UPDATE CASCADE unchanged).
ALTER TABLE "wallets" DROP CONSTRAINT "wallets_user_id_fkey";
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_wallet_id_fkey";
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "game_bets" DROP CONSTRAINT "game_bets_user_id_fkey";
ALTER TABLE "game_bets" ADD CONSTRAINT "game_bets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "game_bets" DROP CONSTRAINT "game_bets_wallet_id_fkey";
ALTER TABLE "game_bets" ADD CONSTRAINT "game_bets_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "game_bets" DROP CONSTRAINT "game_bets_round_id_fkey";
ALTER TABLE "game_bets" ADD CONSTRAINT "game_bets_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "game_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "profiles" DROP CONSTRAINT "profiles_user_id_fkey";
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- F-065: tombstone marker — set when a player's PII is scrubbed in place (ledger/bets kept).
-- Nullable, no default ⇒ metadata-only column add (no table rewrite). null = not anonymized.
ALTER TABLE "users" ADD COLUMN "anonymized_at" TIMESTAMPTZ(6);
