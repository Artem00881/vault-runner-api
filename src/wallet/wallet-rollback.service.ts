import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { OperatorWalletApi } from "./operator-wallet.types";

/** A rollback the RGS needs to apply at the operator, identified by its operator txId. */
export interface RollbackClaim {
  operatorId: string;
  playerId: string;
  currency: string;
  /**
   * The ORIGINAL operator transaction being reversed — the key the OPERATOR dedups on (the
   * drain re-emits the operator rollback with this). REUSABLE on our side: a debit key
   * `bet:{round}:{user}:{panel}:debit` is reused by a re-bet on the same slot, so this is NOT
   * the once-only identity — see {@link dedupeKeyOf}.
   */
  transactionId: string;
  /** ambiguous_debit | transient_debit | void_reclaim | void_refund */
  reason: string;
  betId?: string;
  /** original move magnitude (minor units) — informational for the drain / reconcile. */
  amount?: bigint;
}

/**
 * The LOGICAL-reversal once-only identity = "undo {reason} for {bet}".
 *
 * Keyed on `betId ?? transactionId` + `reason` so the marker is INTENT-AND-BET-distinct, NOT
 * the raw (reusable) operator transactionId (audit M1 — the cross-intent / same-reason-
 * different-bet conflation fix):
 *   - A void RESUME re-emits void_refund for the SAME bet → same betId + same reason → same
 *     dedupeKey → correctly suppressed (F-002 once-only preserved). ✓
 *   - ambiguous_debit on bet B1 (`B1#ambiguous_debit`) vs void_refund on bet B2
 *     (`B2#void_refund`) on the SAME reusable debit key → DISTINCT dedupeKeys → no cross-
 *     suppression (a void no longer strands a re-bet's live stake). ✓
 *   - void_reclaim (undo the payout) + void_refund (undo the debit) on the SAME bet → different
 *     reasons → distinct dedupeKeys → both independently once-only. ✓
 *   - Two ambiguous_debit compensations on the same key for two different rejected attempts
 *     (different betIds) → distinct dedupeKeys → BOTH emit (neither suppresses the other). ✓
 *
 * Falls back to `transactionId` only when there is no betId (defensive — every production
 * caller passes ref.refId; a debit/void always has a bet).
 */
export function dedupeKeyOf(c: { betId?: string | null; transactionId: string; reason: string }): string {
  return `${c.betId ?? c.transactionId}#${c.reason}`;
}

/** Identity a confirm/failure update targets — the once-only (operatorId, dedupeKey). */
export interface RollbackRef {
  operatorId: string;
  dedupeKey: string;
}

/**
 * The durable side of an operator-wallet rollback (audit M1 — F-002 + F-027).
 *
 * {@link SeamlessOperatorWallet} talks to this through {@link RollbackStore} so the pure
 * unit tests can run it WITHOUT a DB (the wallet's store arg is optional). It is a thin
 * layer over `wallet_rollbacks` (NO FK, mutable pending→confirmed) and is BEST-EFFORT by
 * design: a store-write failure must NEVER throw into a caller's reject path — it degrades
 * to "treat as not-confirmed, emit anyway + rely on the operator's own dedup", i.e. exactly
 * today's behaviour (no-worse-than-today), never a thrown error that masks the real failure.
 */
export interface RollbackStore {
  /**
   * Stake a once-only claim on (operatorId, dedupeKey) — the LOGICAL reversal "undo {reason}
   * for {bet}", NOT the reusable transactionId — AND, when there is an emit to do, ACQUIRE the
   * `draining` lease so exactly one path (this live caller OR the drain) owns it (#2). Returns:
   *   - `alreadyConfirmed`: this reversal already applied (`confirmed`) → the caller SKIPS
   *     re-emitting (the F-002 guard).
   *   - `inFlight` (#2): another path (the drain, or a concurrent live caller) currently owns
   *     this reversal (`draining`, live lease) → the caller SKIPS emitting so the two can't
   *     double-reverse a non-idempotent operator. The owner confirms it; if the owner's emit
   *     fails the row returns to pending and a later sweep re-emits — the owed reversal is
   *     durable, never lost.
   *   - When NEITHER flag is set the caller has ACQUIRED the lease (row is now `draining`) and
   *     MUST emit, then confirm()/recordEmitFailure() to release it.
   *   - `ref`: (operatorId+dedupeKey) the caller threads to confirm()/recordEmitFailure().
   * NEVER throws (best-effort) — on a store failure it returns alreadyConfirmed:false,
   * inFlight:false so the caller still emits (no-worse-than-today).
   */
  claim(c: RollbackClaim): Promise<{ alreadyConfirmed: boolean; inFlight: boolean; ref: RollbackRef }>;
  /** Mark the rollback successfully applied at the operator. Best-effort. */
  confirm(ref: RollbackRef): Promise<void>;
  /** Record that the operator rollback emit failed; the row stays `pending` for the drain. */
  recordEmitFailure(ref: RollbackRef, err: unknown): Promise<void>;
}

/** Loud-log threshold: a pending rollback that has survived this many drain attempts is escalated. */
const ROLLBACK_ATTEMPT_ALERT = 10;

/**
 * #2: how long a drain owns a `draining` row before its lease is reclaimable. A drain that
 * crashes mid-emit leaves a `draining` row; the next pass past this age re-claims it. Generous
 * vs a single operator HTTP call (seconds) so a healthy in-flight emit is never stolen.
 */
const DRAIN_LEASE_MS = 60_000;

@Injectable()
export class WalletRollbackService implements RollbackStore {
  private readonly log = new Logger(WalletRollbackService.name);

  constructor(private readonly prisma: PrismaService) {}

  async claim(c: RollbackClaim): Promise<{ alreadyConfirmed: boolean; inFlight: boolean; ref: RollbackRef }> {
    const dedupeKey = dedupeKeyOf(c);
    const ref: RollbackRef = { operatorId: c.operatorId, dedupeKey };
    try {
      const existing = await this.prisma.walletRollback.findUnique({
        where: { operatorId_dedupeKey: { operatorId: c.operatorId, dedupeKey } },
      });

      if (existing) {
        // Already applied → skip (F-002 once-only). The reusable transactionId is irrelevant.
        if (existing.status === "confirmed") return { alreadyConfirmed: true, inFlight: false, ref };
        // Someone else (the drain, or a concurrent live caller) holds a LIVE lease → in-flight,
        // do not also emit (#2). Bump attempts so a stuck owed-rollback stays visible.
        if (this.hasLiveLease(existing.status, existing.leaseUntil)) {
          await this.bumpAttempts(existing.id);
          return { alreadyConfirmed: false, inFlight: true, ref };
        }
        // pending, or a STALE draining lease (a crashed owner) → ACQUIRE the lease so WE own
        // the emit and the drain (or another live caller) can't also emit (#2). The CAS pins
        // the exact (status, lease) we read, so concurrent acquirers can't both win.
        if (await this.acquireLease(existing.id, existing.status, existing.leaseUntil)) {
          return { alreadyConfirmed: false, inFlight: false, ref }; // we own it → emit
        }
        // Lost the acquire race to a concurrent caller → it now owns it (or already confirmed).
        const after = await this.prisma.walletRollback.findUnique({
          where: { operatorId_dedupeKey: { operatorId: c.operatorId, dedupeKey } },
        });
        await this.bumpAttempts(existing.id);
        return { alreadyConfirmed: after?.status === "confirmed", inFlight: after?.status !== "confirmed", ref };
      }

      // First sighting: insert the row ALREADY `draining` with a fresh lease — the inserter
      // owns the emit immediately (so a drain that scans it mid-emit sees a live lease and
      // skips). Stores the reusable transactionId (the drain re-emits with it) alongside the
      // intent+bet-distinct dedupeKey.
      try {
        await this.prisma.walletRollback.create({
          data: {
            operatorId: c.operatorId,
            playerId: c.playerId,
            currency: c.currency,
            transactionId: c.transactionId,
            dedupeKey,
            reason: c.reason,
            betId: c.betId ?? null,
            amount: c.amount ?? null,
            status: "draining",
            leaseUntil: new Date(Date.now() + DRAIN_LEASE_MS),
          },
        });
        return { alreadyConfirmed: false, inFlight: false, ref }; // we own it → emit
      } catch (e) {
        // Concurrent-insert race backstop (mirrors LedgerService.record): another path
        // inserted the same (operatorId, dedupeKey) first → it owns the emit; we skip.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          const row = await this.prisma.walletRollback.findUnique({
            where: { operatorId_dedupeKey: { operatorId: c.operatorId, dedupeKey } },
          });
          return { alreadyConfirmed: row?.status === "confirmed", inFlight: row?.status !== "confirmed", ref };
        }
        throw e;
      }
    } catch (err) {
      // Best-effort: a store failure must NOT throw into the caller's reject path. Degrade
      // to "not confirmed" so the caller still emits the rollback (no-worse-than-today —
      // the operator dedups its own retry). Loud so a broken store is visible.
      this.log.error(
        `wallet-rollback CLAIM failed (best-effort, not rethrown) op=${c.operatorId} dedupe=${dedupeKey}: ${String(err)}`,
      );
      return { alreadyConfirmed: false, inFlight: false, ref };
    }
  }

  /** A row currently OWNED by some emitter — `draining` with a lease that has NOT expired. */
  private hasLiveLease(status: string, leaseUntil: Date | null): boolean {
    return status === "draining" && leaseUntil != null && leaseUntil.getTime() > Date.now();
  }

  /**
   * #2: atomically take the `draining` lease for a row, pinning the EXACT (status, lease) we
   * read so concurrent acquirers (live-void ↔ drain, or two live callers) can't both win.
   * Returns whether THIS call acquired it. Shared by claim() (live path) and drainPending().
   */
  private async acquireLease(id: string, status: string, leaseUntil: Date | null): Promise<boolean> {
    const res = await this.prisma.walletRollback.updateMany({
      where: { id, status, ...(status === "draining" ? { leaseUntil } : {}) },
      data: { status: "draining", leaseUntil: new Date(Date.now() + DRAIN_LEASE_MS) },
    });
    return res.count === 1;
  }

  private async bumpAttempts(id: string): Promise<void> {
    await this.prisma.walletRollback.update({ where: { id }, data: { attempts: { increment: 1 } } }).catch(() => {});
  }

  async confirm(ref: RollbackRef): Promise<void> {
    try {
      await this.prisma.walletRollback.updateMany({
        where: { operatorId: ref.operatorId, dedupeKey: ref.dedupeKey },
        data: { status: "confirmed", resolvedAt: new Date(), lastError: null, leaseUntil: null },
      });
    } catch (err) {
      // A failed confirm leaves the row `pending`/`draining` → the drain re-emits an
      // idempotent rollback that the operator no-ops. Worst case is one redundant rollback,
      // never a double-reverse. Never throw.
      this.log.error(
        `wallet-rollback CONFIRM failed (best-effort) op=${ref.operatorId} dedupe=${ref.dedupeKey}: ${String(err)}`,
      );
    }
  }

  async recordEmitFailure(ref: RollbackRef, err: unknown): Promise<void> {
    try {
      // Release any drain lease too (status back to pending) so the next sweep re-attempts.
      await this.prisma.walletRollback.updateMany({
        where: { operatorId: ref.operatorId, dedupeKey: ref.dedupeKey },
        data: { lastError: String(err).slice(0, 500), status: "pending", leaseUntil: null },
      });
    } catch (e) {
      this.log.error(
        `wallet-rollback recordEmitFailure failed (best-effort) op=${ref.operatorId} dedupe=${ref.dedupeKey}: ${String(e)}`,
      );
    }
  }

  /**
   * Re-emit every still-owed (`pending`, or `draining` past a stale lease) rollback against
   * the operator (F-027 recovery). A no-op when `operator` is null (internal mode — there is
   * no operator to call). Idempotent at the operator on the original transactionId, and
   * idempotent on OUR side (a confirmed row drops out of the scan). Loudly escalates a row
   * that keeps failing past the alert threshold; NEVER abandons it (status returns to pending
   * → retried next sweep). Returns the number CONFIRMED this pass.
   *
   * #2 (claim/drain atomicity): each row is CAS-claimed pending|stale-draining → `draining`
   * with a fresh lease BEFORE the operator emit, so a concurrent live-void resume sees the
   * in-flight `draining` row and does NOT also emit (the only race is sweep-vs-live-void — the
   * overlap-guard + leader-gate already make sweep-vs-sweep impossible). The CAS `updateMany`
   * is atomic, so exactly one path wins a given row. A crashed drain's stale `draining` lease
   * is reclaimed here on the next pass; a row is never left stuck in `draining`.
   */
  async drainPending(operator: OperatorWalletApi | null, limit = 50): Promise<number> {
    if (!operator) return 0;
    let rows;
    try {
      const now = new Date();
      rows = await this.prisma.walletRollback.findMany({
        where: {
          OR: [
            { status: "pending" },
            // Reclaim a crashed owner's lease: a `draining` row whose lease has EXPIRED
            // (leaseUntil < now — the same liveness boundary hasLiveLease() uses). A healthy
            // in-flight emit (lease in the future) is NOT reclaimed.
            { status: "draining", leaseUntil: { lt: now } },
            // Defensive: a `draining` row with a NULL lease (shouldn't happen) — treat as owed.
            { status: "draining", leaseUntil: null },
          ],
        },
        take: limit,
        orderBy: { createdAt: "asc" },
      });
    } catch (err) {
      this.log.error(`wallet-rollback drain scan failed (best-effort): ${String(err)}`);
      return 0;
    }

    let confirmed = 0;
    for (const r of rows) {
      const ref: RollbackRef = { operatorId: r.operatorId, dedupeKey: r.dedupeKey };

      // #2: CAS-claim this row → `draining` with a fresh lease. The WHERE pins the EXACT
      // status+lease we read, so a concurrent live-void (or another reclaimer) that already
      // took it loses the race (count===0) → we skip emitting. Atomic; no row lock held across
      // the operator HTTP call.
      let acquired = false;
      try {
        // Only claim if it's still in the state we scanned (pending, or the SAME stale draining
        // lease) — pins against a confirm / a competing reclaim / a live-void claim landing
        // first. Atomic, so exactly one path owns the emit for this row.
        acquired = await this.acquireLease(r.id, r.status, r.leaseUntil);
      } catch (err) {
        this.log.error(`wallet-rollback drain CAS failed (best-effort) dedupe=${r.dedupeKey}: ${String(err)}`);
        continue;
      }
      if (!acquired) continue; // lost the race — another path owns this emit now.

      try {
        await operator.rollback(r.operatorId, {
          playerId: r.playerId,
          currency: r.currency,
          transactionId: r.transactionId, // the ORIGINAL operator key — unchanged by the dedupe split
          roundId: "", // statement context only; the operator reverses by transactionId
          betId: r.betId ?? "",
        });
        await this.confirm(ref);
        confirmed++;
      } catch (err) {
        // Still failing (operator down / clawback rejected) — bump attempts + record the
        // error, RELEASE the lease (status back to pending), leave it for the next sweep.
        // Escalate loudly past the threshold.
        const attempts = r.attempts + 1;
        await this.prisma.walletRollback
          .update({
            where: { id: r.id },
            data: { attempts, lastError: String(err).slice(0, 500), status: "pending", leaseUntil: null },
          })
          .catch(() => {});
        if (attempts >= ROLLBACK_ATTEMPT_ALERT) {
          this.log.error(
            `STUCK operator rollback: op=${r.operatorId} tx=${r.transactionId} reason=${r.reason} ` +
              `attempts=${attempts} — still retrying (a discrepancy is never abandoned). Check the operator wallet.`,
          );
        }
      }
    }
    return confirmed;
  }

  /** Count rollbacks still owed to the operator (pending or in-flight draining). Cheap. */
  async countPending(): Promise<number> {
    return this.prisma.walletRollback.count({ where: { status: { in: ["pending", "draining"] } } });
  }
}
