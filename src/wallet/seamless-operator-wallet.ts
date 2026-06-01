import { BadRequestException } from "@nestjs/common";
import type { LedgerType, LedgerRef } from "./ledger.service";
import type { WalletProvider, WalletTxResult } from "./wallet-provider";
import {
  type OperatorWalletApi,
  OperatorInsufficientFunds,
  OperatorTimeout,
} from "./operator-wallet.types";

/**
 * Resolves an internal `walletId` to the operator-side session it belongs to.
 * In production this comes from the signed launch token (Phase 0.3); for now
 * it's an injected function so the provider stays testable in isolation.
 */
export interface OperatorSession {
  operatorId: string;
  playerId: string;
  currency: string;
  /** Optional context for the operator's statement. */
  roundId?: string;
}
export type SessionResolver = (walletId: string) => Promise<OperatorSession>;

export interface SeamlessOptions {
  /** Max attempts for a transient failure before giving up (default 3). */
  maxRetries?: number;
}

/**
 * `WalletProvider` backed by an OPERATOR's seamless wallet (the operator's
 * balance is the source of truth — we never hold real funds).
 *
 * Safety model (the whole point of Phase 0.2):
 *  - Every money move carries the `idempotencyKey` AS the operator
 *    `transactionId`, so the operator dedups a retry → no double-charge.
 *  - On an AMBIGUOUS failure (timeout — we don't know if the operator applied
 *    it), we do NOT blindly retry the charge. We issue a `rollback` for that
 *    transactionId: the operator undoes it if it applied, or no-ops if it
 *    didn't. Either way the player's balance ends correct, and we surface the
 *    failure to the caller (the bet is rejected) rather than risk a silent
 *    double transaction.
 *  - A clean "insufficient funds" is a normal rejection, not an error.
 */
export class SeamlessOperatorWallet implements WalletProvider {
  private readonly maxRetries: number;

  constructor(
    private readonly operator: OperatorWalletApi,
    private readonly resolveSession: SessionResolver,
    opts: SeamlessOptions = {},
  ) {
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async debit(
    walletId: string,
    amount: bigint,
    _type: LedgerType,
    idempotencyKey: string,
    ref?: LedgerRef,
  ): Promise<WalletTxResult> {
    const s = await this.resolveSession(walletId);
    return this.move("bet", s, walletId, Number(amount), idempotencyKey, ref);
  }

  async credit(
    walletId: string,
    amount: bigint,
    _type: LedgerType,
    idempotencyKey: string,
    ref?: LedgerRef,
  ): Promise<WalletTxResult> {
    const s = await this.resolveSession(walletId);
    return this.move("win", s, walletId, Number(amount), idempotencyKey, ref);
  }

  async rollback(walletId: string, idempotencyKey: string, ref?: LedgerRef): Promise<void> {
    const s = await this.resolveSession(walletId);
    await this.operator.rollback(s.operatorId, {
      playerId: s.playerId,
      currency: s.currency,
      transactionId: idempotencyKey,
      roundId: s.roundId ?? "",
      betId: ref?.refId ?? "",
    });
  }

  async getBalance(walletId: string): Promise<bigint> {
    const s = await this.resolveSession(walletId);
    const bal = await this.operator.balance(s.operatorId, s.playerId, s.currency);
    return BigInt(Math.trunc(bal));
  }

  /** Core debit/credit with retry + compensating rollback on ambiguity. */
  private async move(
    kind: "bet" | "win",
    s: OperatorSession,
    walletId: string,
    amount: number,
    transactionId: string,
    ref?: LedgerRef,
  ): Promise<WalletTxResult> {
    const req = {
      playerId: s.playerId,
      currency: s.currency,
      amount,
      transactionId, // = idempotencyKey → operator dedups retries
      roundId: s.roundId ?? "",
      betId: ref?.refId ?? "",
    };

    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const res =
          kind === "bet"
            ? await this.operator.bet(s.operatorId, req)
            : await this.operator.win(s.operatorId, req);
        return { id: res.operatorTxId, balanceAfter: BigInt(Math.trunc(res.balance)) };
      } catch (e) {
        lastErr = e;

        // Clean business rejection — don't retry, surface as-is.
        if (e instanceof OperatorInsufficientFunds) {
          throw new BadRequestException("insufficient_balance");
        }

        // Timeout = AMBIGUOUS. The operator may or may not have applied it.
        // Compensate: rollback this transactionId (idempotent), then fail.
        if (e instanceof OperatorTimeout) {
          await this.safeRollback(s, transactionId, ref);
          throw new BadRequestException("wallet_unavailable");
        }

        // Other errors: retry a couple of times (transient), then give up.
        if (attempt >= this.maxRetries) {
          await this.safeRollback(s, transactionId, ref);
          throw new BadRequestException("wallet_error");
        }
      }
    }
    throw lastErr;
  }

  /** Best-effort rollback; never throws (we're already in a failure path). */
  private async safeRollback(s: OperatorSession, transactionId: string, ref?: LedgerRef) {
    try {
      await this.operator.rollback(s.operatorId, {
        playerId: s.playerId,
        currency: s.currency,
        transactionId,
        roundId: s.roundId ?? "",
        betId: ref?.refId ?? "",
      });
    } catch {
      // TODO Phase 0.3: if rollback itself fails, flag for the reconciliation
      // job rather than losing the discrepancy.
    }
  }
}
