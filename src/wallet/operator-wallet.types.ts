/**
 * Operator seamless-wallet contract (RGS → operator).
 *
 * This is the API an OPERATOR (casino / aggregator) exposes and that our
 * SeamlessOperatorWallet calls. The operator's wallet is the source of truth for
 * the player's real money; we never hold their funds. This file is the typed
 * contract — the same shape will be published to operators as the integration
 * spec (Phase 6 docs).
 *
 * Money is integer minor units (currency-agnostic; see game-math-spec §8/§12).
 * Every state-changing call carries a unique `transactionId` so the operator can
 * make it idempotent (a retry must NOT double-apply).
 */

export interface OperatorBetRequest {
  /** Operator-side player session/account the launch token resolved to. */
  playerId: string;
  currency: string;
  /** Positive minor units to debit (the stake). */
  amount: number;
  /** Unique per money-move; the operator dedups on this. */
  transactionId: string;
  /** Context for the operator's statement (our round/bet ids). */
  roundId: string;
  betId: string;
}

export interface OperatorWinRequest {
  playerId: string;
  currency: string;
  /** Positive minor units to credit (the payout). */
  amount: number;
  transactionId: string;
  roundId: string;
  betId: string;
}

export interface OperatorRollbackRequest {
  playerId: string;
  currency: string;
  /** The transactionId of the bet/win being undone. */
  transactionId: string;
  roundId: string;
  betId: string;
}

/** Operator responds with the authoritative post-move balance. */
export interface OperatorWalletResponse {
  /** Operator's own reference id for the applied transaction. */
  operatorTxId: string;
  /** Player balance after the move, minor units. */
  balance: number;
}

/**
 * The calls our SeamlessOperatorWallet makes against the operator. A real
 * implementation issues HTTP/JSON (or gRPC) requests; the mock implements the
 * same shape in-memory for tests.
 *
 * The leading `operatorId` is OUR multi-tenant ROUTING key — it tells the client
 * which operator's `walletApiUrl` + `walletApiKey` to dial. It is NOT part of
 * the wire payload published to operators (they already know who they are); the
 * request bodies above stay the clean operator-facing contract.
 */
export interface OperatorWalletApi {
  balance(operatorId: string, playerId: string, currency: string): Promise<number>;
  bet(operatorId: string, req: OperatorBetRequest): Promise<OperatorWalletResponse>;
  win(operatorId: string, req: OperatorWinRequest): Promise<OperatorWalletResponse>;
  rollback(operatorId: string, req: OperatorRollbackRequest): Promise<OperatorWalletResponse>;
}

/** Operator-side error categories our provider must handle distinctly. */
export class OperatorInsufficientFunds extends Error {
  constructor() { super("operator_insufficient_funds"); }
}
export class OperatorTimeout extends Error {
  constructor() { super("operator_timeout"); }
}
export class OperatorError extends Error {
  constructor(msg = "operator_error") { super(msg); }
}
