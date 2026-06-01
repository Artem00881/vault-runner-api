import type { LedgerTransaction } from "@prisma/client";
import type { LedgerType, LedgerRef } from "./ledger.service";

/**
 * Abstraction over where player money lives (Phase 0 "money pivot").
 *
 * The game logic (bets, cash-out, settlement) talks ONLY to this interface, so
 * the source of truth can be swapped without touching the engine:
 *
 *  - `InternalLedgerProvider`  — the built-in append-only ledger (LedgerService).
 *    Source of truth = our DB. Powers the demo / fun mode and internal testing.
 *  - `SeamlessOperatorWallet`  — (Phase 0.2) the operator's wallet is the source
 *    of truth; debit/credit call the operator API, our ledger becomes a
 *    per-operator reconciliation journal.
 *
 * Mirrors the SALT_PROVIDER symbol-DI pattern in `fairness/salt.provider.ts`.
 *
 * NOTE (0.1): the return type is the internal `LedgerTransaction` for now to keep
 * this a zero-behaviour-change refactor. 0.2 will generalise it to a small
 * provider-neutral result (id + balanceAfter) so the operator provider doesn't
 * have to fabricate a Prisma row.
 */
export interface WalletProvider {
  /** Move `amount` (positive minor units) OUT of the wallet (e.g. place a bet). */
  debit(
    walletId: string,
    amount: bigint,
    type: LedgerType,
    idempotencyKey: string,
    ref?: LedgerRef,
  ): Promise<LedgerTransaction>;

  /** Move `amount` (positive minor units) INTO the wallet (e.g. payout / refund). */
  credit(
    walletId: string,
    amount: bigint,
    type: LedgerType,
    idempotencyKey: string,
    ref?: LedgerRef,
  ): Promise<LedgerTransaction>;

  /** Current balance (minor units). */
  getBalance(walletId: string): Promise<bigint>;
}

/** DI token for the active WalletProvider (mirrors SALT_PROVIDER). */
export const WALLET_PROVIDER = Symbol("WALLET_PROVIDER");
