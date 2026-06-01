import type { LedgerType, LedgerRef } from "./ledger.service";

/**
 * Abstraction over where player money lives (Phase 0 "money pivot").
 *
 * The game logic (bets, cash-out, settlement) talks ONLY to this interface, so
 * the source of truth can be swapped without touching the engine:
 *
 *  - `InternalLedgerProvider`  — the built-in append-only ledger (LedgerService).
 *    Source of truth = our DB. Powers the demo / fun mode and internal testing.
 *  - `SeamlessOperatorWallet`  — the operator's wallet is the source of truth;
 *    debit/credit/rollback call the operator API, and our ledger becomes a
 *    per-operator reconciliation journal.
 *
 * Mirrors the SALT_PROVIDER symbol-DI pattern in `fairness/salt.provider.ts`.
 */

/**
 * Provider-neutral result of a money movement. Both the internal ledger and an
 * external operator wallet can produce this: a transaction id and the balance
 * after the move. (Our `LedgerTransaction` row already has both fields, so it is
 * structurally assignable to this — no change in internal behaviour.)
 */
export interface WalletTxResult {
  /** Unique id of the applied transaction (ledger row id, or operator tx id). */
  id: string;
  /** Wallet balance after the move, in minor units. */
  balanceAfter: bigint;
}

export interface WalletProvider {
  /** Move `amount` (positive minor units) OUT of the wallet (e.g. place a bet). */
  debit(
    walletId: string,
    amount: bigint,
    type: LedgerType,
    idempotencyKey: string,
    ref?: LedgerRef,
  ): Promise<WalletTxResult>;

  /** Move `amount` (positive minor units) INTO the wallet (e.g. payout / refund). */
  credit(
    walletId: string,
    amount: bigint,
    type: LedgerType,
    idempotencyKey: string,
    ref?: LedgerRef,
  ): Promise<WalletTxResult>;

  /**
   * Undo a previously-attempted debit/credit identified by its idempotency key.
   * Used when a money move is ambiguous (e.g. an operator call timed out and we
   * can't tell if it applied). For the internal ledger this is a safe no-op
   * (its operations are atomic — there is nothing to compensate); for an
   * operator wallet it calls the operator's rollback endpoint.
   */
  rollback(walletId: string, idempotencyKey: string, ref?: LedgerRef): Promise<void>;

  /** Current balance (minor units). */
  getBalance(walletId: string): Promise<bigint>;
}

/** DI token for the active WalletProvider (mirrors SALT_PROVIDER). */
export const WALLET_PROVIDER = Symbol("WALLET_PROVIDER");
