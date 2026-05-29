import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma, type LedgerTransaction } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

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
 */
@Injectable()
export class LedgerService {
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
