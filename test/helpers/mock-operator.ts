import { randomUUID } from "node:crypto";
import type {
  OperatorWalletApi,
  OperatorBetRequest,
  OperatorWinRequest,
  OperatorRollbackRequest,
  OperatorWalletResponse,
} from "../../src/wallet/operator-wallet.types";
import {
  OperatorInsufficientFunds,
  OperatorTimeout,
} from "../../src/wallet/operator-wallet.types";

/**
 * In-memory fake of an operator's seamless wallet, for contract tests.
 *
 * It is idempotent like a real operator (dedups on transactionId) and can be
 * told to MISBEHAVE on the next call, so we can reproduce the classic failure
 * modes our SeamlessOperatorWallet must survive:
 *   - timeout-after-apply: the operator APPLIED the move but our call "times
 *     out" (we never get the response) — does our side double-charge on retry?
 *   - timeout-before-apply: the call times out and nothing applied.
 *   - hard error.
 */
type Misbehave =
  | { kind: "timeout_after_apply" }
  | { kind: "timeout_before_apply" }
  | { kind: "error" };

export class MockOperator implements OperatorWalletApi {
  private balances = new Map<string, number>(); // key: `${playerId}:${currency}`
  private applied = new Map<string, OperatorWalletResponse>(); // transactionId → result
  private deltas = new Map<string, number>(); // transactionId → signed delta (for rollback)
  private next: Misbehave | null = null;

  /** Public counters so tests can assert how many times the operator was hit. */
  calls = { bet: 0, win: 0, rollback: 0, balance: 0 };

  constructor(seed: Record<string, number> = {}) {
    for (const [k, v] of Object.entries(seed)) this.balances.set(k, v);
  }

  /** Arm a single misbehaviour for the NEXT state-changing call. */
  misbehaveOnce(m: Misbehave) { this.next = m; }

  private key(playerId: string, currency: string) { return `${playerId}:${currency}`; }

  async balance(_operatorId: string, playerId: string, currency: string): Promise<number> {
    this.calls.balance++;
    return this.balances.get(this.key(playerId, currency)) ?? 0;
  }

  private apply(
    txId: string,
    playerId: string,
    currency: string,
    delta: number,
  ): OperatorWalletResponse {
    // Idempotent: a repeated transactionId returns the SAME result, no re-apply.
    const dup = this.applied.get(txId);
    if (dup) return dup;

    const k = this.key(playerId, currency);
    const bal = this.balances.get(k) ?? 0;
    const after = bal + delta;
    if (after < 0) throw new OperatorInsufficientFunds();
    this.balances.set(k, after);
    const res: OperatorWalletResponse = { operatorTxId: randomUUID(), balance: after };
    this.applied.set(txId, res);
    this.deltas.set(txId, delta); // remember for an exact rollback
    return res;
  }

  /** Run the move, honouring any armed misbehaviour. */
  private async run(
    txId: string,
    playerId: string,
    currency: string,
    delta: number,
  ): Promise<OperatorWalletResponse> {
    const m = this.next;
    this.next = null;

    if (m?.kind === "timeout_before_apply") {
      throw new OperatorTimeout(); // nothing applied
    }
    if (m?.kind === "error") {
      throw new Error("operator_boom");
    }
    if (m?.kind === "timeout_after_apply") {
      // The operator DID apply it, but we never get the response.
      this.apply(txId, playerId, currency, delta);
      throw new OperatorTimeout();
    }
    return this.apply(txId, playerId, currency, delta);
  }

  async bet(_operatorId: string, req: OperatorBetRequest): Promise<OperatorWalletResponse> {
    this.calls.bet++;
    return this.run(req.transactionId, req.playerId, req.currency, -req.amount);
  }

  async win(_operatorId: string, req: OperatorWinRequest): Promise<OperatorWalletResponse> {
    this.calls.win++;
    return this.run(req.transactionId, req.playerId, req.currency, +req.amount);
  }

  async rollback(_operatorId: string, req: OperatorRollbackRequest): Promise<OperatorWalletResponse> {
    this.calls.rollback++;
    // Undo the named transaction if it was applied; idempotent on its own txId.
    const orig = this.applied.get(req.transactionId);
    const k = this.key(req.playerId, req.currency);
    if (orig) {
      // reverse the effect: recompute from the stored result is overkill; we
      // simply mark it rolled back and restore the delta. The test operator
      // stores deltas implicitly via balance, so reverse by reapplying inverse.
      // To keep it simple+correct, we store original deltas:
      const delta = this.deltas.get(req.transactionId) ?? 0;
      this.balances.set(k, (this.balances.get(k) ?? 0) - delta);
      this.applied.delete(req.transactionId);
      this.deltas.delete(req.transactionId);
    }
    return { operatorTxId: randomUUID(), balance: this.balances.get(k) ?? 0 };
  }

  /** test helper */
  balanceOf(playerId: string, currency: string) {
    return this.balances.get(this.key(playerId, currency)) ?? 0;
  }
}
