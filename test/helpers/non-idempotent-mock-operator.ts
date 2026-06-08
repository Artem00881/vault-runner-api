import { randomUUID } from "node:crypto";
import type {
  OperatorWalletApi,
  OperatorBetRequest,
  OperatorWinRequest,
  OperatorRollbackRequest,
  OperatorWalletResponse,
} from "../../src/wallet/operator-wallet.types";
import { OperatorInsufficientFunds, OperatorTimeout } from "../../src/wallet/operator-wallet.types";

/**
 * A DELIBERATELY NON-IDEMPOTENT operator wallet, the adversary for the M1 once-only guard
 * (audit F-002/F-075). It is the mirror image of {@link MockOperator}: bet/win still dedup
 * on transactionId, but `rollback` APPLIES the inverse delta on EVERY call — it remembers
 * the original move's delta PERMANENTLY (never forgets it) and re-credits/re-debits on each
 * rollback of that txId. So a SECOND rollback of the same transaction OVER-reverses.
 *
 * This is exactly the operator behaviour the RGS must NOT rely on being idempotent: with
 * the SeamlessOperatorWallet's durable rollback ledger wired, a confirmed txId is never
 * re-emitted, so even this operator nets correct. Without the guard, a void resume /
 * ambiguous-debit retry would double-reverse against it (the fails-first behaviour).
 *
 * Optional `misbehaveOnce` is supported (like MockOperator) so a test can fail a debit and
 * exercise safeRollback. `seed`/`balanceOf`/the constructor accept number|bigint.
 */
type Misbehave =
  | { kind: "timeout_after_apply" }
  | { kind: "timeout_before_apply" }
  | { kind: "error" };

export class NonIdempotentMockOperator implements OperatorWalletApi {
  private balances = new Map<string, bigint>(); // `${playerId}:${currency}` → balance
  private applied = new Map<string, OperatorWalletResponse>(); // bet/win dedup (these ARE idempotent)
  private deltas = new Map<string, bigint>(); // transactionId → original signed delta (REMEMBERED FOREVER)
  /** When set, the NEXT rollback of this txId throws once (for the F-027 pending path). */
  private rollbackFailOnce = new Set<string>();
  private next: Misbehave | null = null;
  /**
   * Deterministic concurrency gate (#2 drain-race test): when armed for a txId, the FIRST
   * rollback of it BLOCKS on a barrier until the test releases it — so the test can drive a
   * second concurrent path (the drain, or the live void) into its claim/CAS WHILE the first
   * emit is in-flight, exercising the exact sweep-vs-live-void window.
   */
  private rollbackGate = new Map<string, { armed: boolean; entered?: () => void; release: Promise<void> }>();

  calls = { bet: 0, win: 0, rollback: 0, balance: 0 };

  constructor(seed: Record<string, number | bigint> = {}) {
    for (const [k, v] of Object.entries(seed)) this.balances.set(k, BigInt(v));
  }

  misbehaveOnce(m: Misbehave) { this.next = m; }
  /** Arm the next rollback of `transactionId` to throw exactly once (then succeed). */
  failNextRollback(transactionId: string) { this.rollbackFailOnce.add(transactionId); }

  /**
   * Arm a one-shot barrier on the next rollback of `transactionId`. Returns:
   *   - `entered`: resolves once that rollback has STARTED (so the test knows the emit is
   *     in-flight and can launch the racing path),
   *   - `release()`: lets the blocked rollback proceed to completion.
   */
  gateNextRollback(transactionId: string): { entered: Promise<void>; release: () => void } {
    let release!: () => void;
    let entered!: () => void;
    const releaseP = new Promise<void>((r) => (release = r));
    const enteredP = new Promise<void>((r) => (entered = r));
    this.rollbackGate.set(transactionId, { armed: true, entered, release: releaseP });
    return { entered: enteredP, release };
  }

  private key(playerId: string, currency: string) { return `${playerId}:${currency}`; }

  async balance(_operatorId: string, playerId: string, currency: string): Promise<string> {
    this.calls.balance++;
    return (this.balances.get(this.key(playerId, currency)) ?? 0n).toString();
  }

  private apply(txId: string, playerId: string, currency: string, delta: bigint): OperatorWalletResponse {
    const dup = this.applied.get(txId);
    if (dup) return dup; // bet/win stay idempotent
    const k = this.key(playerId, currency);
    const bal = this.balances.get(k) ?? 0n;
    const after = bal + delta;
    if (after < 0n) throw new OperatorInsufficientFunds();
    this.balances.set(k, after);
    const res: OperatorWalletResponse = { operatorTxId: "op-tx-" + randomUUID(), balance: after.toString() };
    this.applied.set(txId, res);
    this.deltas.set(txId, delta); // remembered FOREVER (never deleted, unlike MockOperator)
    return res;
  }

  private async run(txId: string, playerId: string, currency: string, delta: bigint): Promise<OperatorWalletResponse> {
    const m = this.next;
    this.next = null;
    if (m?.kind === "timeout_before_apply") throw new OperatorTimeout();
    if (m?.kind === "error") throw new Error("operator_boom");
    if (m?.kind === "timeout_after_apply") {
      this.apply(txId, playerId, currency, delta);
      throw new OperatorTimeout();
    }
    return this.apply(txId, playerId, currency, delta);
  }

  async bet(_operatorId: string, req: OperatorBetRequest): Promise<OperatorWalletResponse> {
    this.calls.bet++;
    return this.run(req.transactionId, req.playerId, req.currency, -BigInt(req.amount));
  }

  async win(_operatorId: string, req: OperatorWinRequest): Promise<OperatorWalletResponse> {
    this.calls.win++;
    return this.run(req.transactionId, req.playerId, req.currency, BigInt(req.amount));
  }

  /**
   * NON-IDEMPOTENT rollback: applies the INVERSE of the original delta on EVERY call. The
   * original delta is remembered permanently, so a repeat rollback of the same txId reverses
   * AGAIN (over-reversal) — the bug the once-only guard must prevent.
   */
  async rollback(_operatorId: string, req: OperatorRollbackRequest): Promise<OperatorWalletResponse> {
    this.calls.rollback++;
    const k = this.key(req.playerId, req.currency);
    // Deterministic barrier (#2 drain-race): signal "entered", then block until released.
    const gate = this.rollbackGate.get(req.transactionId);
    if (gate?.armed) {
      this.rollbackGate.delete(req.transactionId); // one-shot
      gate.entered?.();
      await gate.release;
    }
    if (this.rollbackFailOnce.has(req.transactionId)) {
      this.rollbackFailOnce.delete(req.transactionId);
      throw new OperatorTimeout(); // a transient rollback-emit failure (→ row stays pending)
    }
    const delta = this.deltas.get(req.transactionId) ?? 0n; // remembered forever
    this.balances.set(k, (this.balances.get(k) ?? 0n) - delta); // re-applies EVERY call
    return { operatorTxId: "op-tx-" + randomUUID(), balance: (this.balances.get(k) ?? 0n).toString() };
  }

  balanceOf(playerId: string, currency: string): bigint {
    return this.balances.get(this.key(playerId, currency)) ?? 0n;
  }

  seed(playerId: string, currency: string, balance: number | bigint) {
    this.balances.set(this.key(playerId, currency), BigInt(balance));
  }
}
