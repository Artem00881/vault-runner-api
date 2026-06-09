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

/**
 * Parameters for {@link WalletProvider.reverse} — reversing an already-APPLIED,
 * settled money move (an operator-initiated void/refund). Carries BOTH the original
 * move's key (so the operator wallet can roll it back on its own statement) AND a
 * fresh reverse key + the amount/direction (so the internal ledger can post the
 * inverse entry). Each provider uses only what its mode needs.
 */
export interface ReverseParams {
  /** The ORIGINAL move's idempotency key — the operator's rollback target. */
  originalKey: string;
  /** Idempotency key for the internal ledger's INVERSE entry (operator mode ignores it). */
  reverseKey: string;
  /** The original move's magnitude (positive minor units). */
  amount: bigint;
  /** What the original move was: refund a `debit` = credit back; reclaim a `credit` = debit back. */
  originalDirection: "debit" | "credit";
  /** Ledger type for the internal inverse entry. */
  type: LedgerType;
  ref?: LedgerRef;
  /**
   * F-082: intent label for the operator-mode once-only rollback dedupe. Two reversals of the
   * SAME bet's stake debit with the SAME `originalDirection: "debit"` — a round-restart refund
   * (closeAndRefundRound) and an operator void refund (performVoidReversals) — otherwise both
   * derive reason "void_refund" and share the dedupeKey `{betId}#void_refund`, so whichever ran
   * first would permanently suppress the other. They are mutually exclusive by bet status today,
   * but giving each its intent-distinct reason (matching its already-distinct reverseKey) makes
   * the dedupe correct by construction. Omitted → the originalDirection-derived default. Ledger/
   * demo mode ignores it (it dedupes on the already-distinct reverseKey).
   */
  intent?: string;
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

  /**
   * Reverse an already-APPLIED, settled money move — an operator-initiated
   * void/refund. UNLIKE {@link rollback} (which compensates an AMBIGUOUS move and is
   * a no-op on the internal ledger), `reverse` ALWAYS returns the money, with
   * mode-correct bookkeeping:
   *  - internal ledger: posts the INVERSE entry under `reverseKey` (refund a debit =
   *    a credit; reclaim a credit = a debit). Idempotent on `reverseKey`. Throws
   *    `insufficient_balance` if a reclaim can't be covered (the clawback-fail case).
   *  - operator wallet: calls the operator's idempotent rollback on `originalKey`, so
   *    the original /bet or /win is undone on the operator's statement — no new
   *    turnover / no GGR inflation. Idempotent on `originalKey` at the operator.
   */
  reverse(walletId: string, params: ReverseParams): Promise<void>;

  /** Current balance (minor units). */
  getBalance(walletId: string): Promise<bigint>;
}

/** DI token for the active WalletProvider (mirrors SALT_PROVIDER). */
export const WALLET_PROVIDER = Symbol("WALLET_PROVIDER");

/**
 * DI token for the RAW per-operator wallet client ({@link OperatorWalletApi}), or `null`
 * in internal mode. Used by the rollback-outbox drain (audit M1 — F-027), which re-emits
 * `operator.rollback(...)` for any owed rollback. Null in internal mode makes the drain a
 * no-op there (no operator exists). Provided by WalletModule alongside WALLET_PROVIDER.
 */
export const OPERATOR_WALLET_API = Symbol("OPERATOR_WALLET_API");
