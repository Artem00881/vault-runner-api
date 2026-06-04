import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma, type LedgerTransaction } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { WalletProvider } from "./wallet-provider";

export type LedgerType =
  | "deposit"
  | "withdrawal"
  | "bet_debit"
  | "payout_credit"
  | "refund"
  | "adjustment";

export interface LedgerRef {
  refType?: string;
  refId?: string;
}

/**
 * Append-only ledger with atomic, idempotent balance changes.
 * Every money movement is one ledger row; `wallets.balance` is the cached total.
 * Guarantees: no negative balance, no double-apply (idempotency key), and a
 * row-level lock to serialize concurrent writes to the same wallet.
 *
 * This is the `InternalLedgerProvider` implementation of {@link WalletProvider}:
 * the source of truth is our own DB (demo / play-money). The game talks to the
 * WALLET_PROVIDER token, so a SeamlessOperatorWallet can replace it later.
 */
@Injectable()
export class LedgerService implements WalletProvider {
  constructor(private readonly prisma: PrismaService) {}

  /** Positive `amount`; stored as a negative ledger entry (debit). */
  debit(walletId: string, amount: bigint, type: LedgerType, idempotencyKey: string, ref?: LedgerRef) {
    if (amount <= 0n) throw new BadRequestException("amount_must_be_positive");
    return this.record(walletId, -amount, type, idempotencyKey, ref);
  }

  /** Positive `amount`; stored as a positive ledger entry (credit). */
  credit(walletId: string, amount: bigint, type: LedgerType, idempotencyKey: string, ref?: LedgerRef) {
    if (amount <= 0n) throw new BadRequestException("amount_must_be_positive");
    return this.record(walletId, amount, type, idempotencyKey, ref);
  }

  async getBalance(walletId: string): Promise<bigint> {
    const w = await this.prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    return w.balance;
  }

  /**
   * No-op for the internal ledger: debit/credit here are single atomic DB
   * transactions, so a money move either fully applied or didn't — there is
   * never an ambiguous half-state to compensate. (The operator wallet provider
   * overrides this with a real rollback call.) Kept to satisfy WalletProvider.
   */
  async rollback(): Promise<void> {
    return;
  }

  /**
   * Set a wallet's balance to `target` (minor units) by recording the signed
   * delta as a single `adjustment` ledger row — atomic (row-locked) and
   * idempotent on `idempotencyKey` (a retried reset is a no-op; a NEW key applies
   * a fresh reset). Returns the adjustment row, or null when already at `target`.
   *
   * Used ONLY to seed / reset-to-full a demo ("fun mode") play-money wallet on
   * each launch (Phase 3). It writes straight to the internal ledger and must
   * NEVER be used on a real operator-backed wallet (the operator is the source of
   * truth there) — demo wallets are physically distinct journals, so this is safe
   * by construction.
   */
  async resetTo(
    walletId: string,
    target: bigint,
    idempotencyKey: string,
    ref?: LedgerRef,
  ): Promise<LedgerTransaction | null> {
    if (target < 0n) throw new BadRequestException("amount_must_not_be_negative"); // target 0 is allowed (zero out)

    // Fast path: this exact reset already applied → return it (idempotent).
    const existing = await this.prisma.ledgerTransaction.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Lock the wallet row so the read-modify-write of the balance is atomic.
        await tx.$executeRawUnsafe(`SELECT id FROM wallets WHERE id = $1::uuid FOR UPDATE`, walletId);

        // Re-check inside the lock in case a concurrent tx applied this key first.
        const dup = await tx.ledgerTransaction.findUnique({ where: { idempotencyKey } });
        if (dup) return dup;

        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
        const delta = target - wallet.balance;
        if (delta === 0n) return null; // already at target — nothing to adjust

        await tx.wallet.update({ where: { id: walletId }, data: { balance: target } });

        return tx.ledgerTransaction.create({
          data: {
            walletId,
            type: "adjustment",
            amount: delta, // signed: positive = top-up, negative = draw-down to target
            balanceAfter: target,
            refType: ref?.refType ?? null,
            refId: ref?.refId ?? null,
            idempotencyKey,
          },
        });
      });
    } catch (e) {
      // Unique-violation backstop: another tx inserted the same key concurrently.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const row = await this.prisma.ledgerTransaction.findUnique({ where: { idempotencyKey } });
        if (row) return row;
      }
      throw e;
    }
  }

  private async record(
    walletId: string,
    signedAmount: bigint,
    type: LedgerType,
    idempotencyKey: string,
    ref?: LedgerRef,
  ): Promise<LedgerTransaction> {
    // Fast path: already applied → return the existing row (idempotent).
    const existing = await this.prisma.ledgerTransaction.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Lock the wallet row for the duration of the transaction.
        await tx.$executeRawUnsafe(`SELECT id FROM wallets WHERE id = $1::uuid FOR UPDATE`, walletId);

        // Re-check inside the lock in case a concurrent tx applied it first.
        const dup = await tx.ledgerTransaction.findUnique({ where: { idempotencyKey } });
        if (dup) return dup;

        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
        const balanceAfter = wallet.balance + signedAmount;
        if (balanceAfter < 0n) throw new BadRequestException("insufficient_balance");

        await tx.wallet.update({ where: { id: walletId }, data: { balance: balanceAfter } });

        return tx.ledgerTransaction.create({
          data: {
            walletId,
            type,
            amount: signedAmount,
            balanceAfter,
            refType: ref?.refType ?? null,
            refId: ref?.refId ?? null,
            idempotencyKey,
          },
        });
      });
    } catch (e) {
      // Unique-violation backstop: another tx inserted the same key concurrently.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const row = await this.prisma.ledgerTransaction.findUnique({ where: { idempotencyKey } });
        if (row) return row;
      }
      throw e;
    }
  }
}
