import {
  type OperatorWalletApi,
  type OperatorBetRequest,
  type OperatorWinRequest,
  type OperatorRollbackRequest,
  type OperatorWalletResponse,
  OperatorInsufficientFunds,
  OperatorTimeout,
  OperatorError,
} from "./operator-wallet.types";

/**
 * HTTP/JSON implementation of the operator seamless-wallet contract
 * ({@link OperatorWalletApi}). This is the real "phone line" the
 * SeamlessOperatorWallet uses to talk to a live operator wallet; the in-memory
 * MockOperator is the test stand-in for the same shape.
 *
 * Wire protocol (POST JSON to `{walletApiUrl}/{bet|win|rollback|balance}`):
 *  - 200  → `{ operatorTxId, balance }` (or `{ balance }` for /balance).
 *  - 402 / 409 / body `{ error: "insufficient_funds" }` → insufficient funds.
 *  - 408 / 504 → operator-side timeout.
 *  - other non-2xx → operator error (transient → retried upstream).
 *  - client-side request timeout (AbortController) → {@link OperatorTimeout}
 *    (AMBIGUOUS: the operator MAY have applied it — the SeamlessOperatorWallet
 *    compensates with an idempotent rollback rather than blind-retrying).
 *  - other network failure (DNS / connection refused) → {@link OperatorError}
 *    (definitely did NOT apply → safe to retry).
 *
 * Auth: `Authorization: Bearer {walletApiKey}` when a key is configured.
 */

/** Per-operator transport target, looked up by the routing `operatorId`. */
export interface OperatorEndpoint {
  walletApiUrl: string;
  walletApiKey: string | null;
}

/** Resolves a routing `operatorId` to its transport endpoint (URL + key). */
export type OperatorEndpointResolver = (operatorId: string) => Promise<OperatorEndpoint>;

export interface HttpOperatorOptions {
  /** Per-request timeout in ms (default env OPERATOR_WALLET_TIMEOUT_MS or 3000). */
  timeoutMs?: number;
}

export class HttpOperatorWalletApi implements OperatorWalletApi {
  private readonly timeoutMs: number;

  constructor(
    private readonly resolveEndpoint: OperatorEndpointResolver,
    opts: HttpOperatorOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.OPERATOR_WALLET_TIMEOUT_MS ?? 3000);
  }

  async balance(operatorId: string, playerId: string, currency: string): Promise<number> {
    const res = await this.post<{ balance: number }>(operatorId, "balance", { playerId, currency });
    return Math.trunc(res.balance);
  }

  async bet(operatorId: string, req: OperatorBetRequest): Promise<OperatorWalletResponse> {
    return this.move(operatorId, "bet", req);
  }

  async win(operatorId: string, req: OperatorWinRequest): Promise<OperatorWalletResponse> {
    return this.move(operatorId, "win", req);
  }

  async rollback(operatorId: string, req: OperatorRollbackRequest): Promise<OperatorWalletResponse> {
    return this.move(operatorId, "rollback", req);
  }

  private async move(
    operatorId: string,
    path: "bet" | "win" | "rollback",
    body: unknown,
  ): Promise<OperatorWalletResponse> {
    const res = await this.post<{ operatorTxId: string; balance: number }>(operatorId, path, body);
    return { operatorTxId: res.operatorTxId, balance: Math.trunc(res.balance) };
  }

  /** One POST to the operator, with timeout + status/error → typed-error mapping. */
  private async post<T>(operatorId: string, path: string, body: unknown): Promise<T> {
    const ep = await this.resolveEndpoint(operatorId);
    if (!ep.walletApiUrl) throw new OperatorError("operator_wallet_not_configured");
    const url = joinUrl(ep.walletApiUrl, path);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(ep.walletApiKey ? { authorization: `Bearer ${ep.walletApiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      // AbortError = our own timeout fired → AMBIGUOUS (may have applied).
      if (e instanceof Error && e.name === "AbortError") throw new OperatorTimeout();
      // Any other fetch throw = never reached the operator → safe to retry.
      throw new OperatorError("operator_network_error");
    } finally {
      clearTimeout(timer);
    }

    if (resp.ok) {
      try {
        return (await resp.json()) as T;
      } catch {
        throw new OperatorError("operator_bad_response");
      }
    }

    const errCode = await safeErrorCode(resp);
    if (resp.status === 402 || resp.status === 409 || errCode === "insufficient_funds") {
      throw new OperatorInsufficientFunds();
    }
    if (resp.status === 408 || resp.status === 504) {
      throw new OperatorTimeout();
    }
    throw new OperatorError(`operator_http_${resp.status}`);
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Best-effort read of a `{ error: string }` body; never throws. */
async function safeErrorCode(resp: Response): Promise<string | null> {
  try {
    const j = (await resp.clone().json()) as { error?: unknown };
    return typeof j?.error === "string" ? j.error : null;
  } catch {
    return null;
  }
}

/**
 * Cached endpoint resolver: looks the per-operator URL + key up once and reuses
 * it for `ttlMs` so a money move isn't a DB round-trip every time. `fetcher` is
 * storage-agnostic (Prisma in prod, a stub in tests).
 */
export function cachedEndpointResolver(
  fetcher: (operatorId: string) => Promise<OperatorEndpoint>,
  ttlMs = 30_000,
): OperatorEndpointResolver {
  const cache = new Map<string, { ep: OperatorEndpoint; exp: number }>();
  return async (operatorId: string) => {
    const now = Date.now();
    const hit = cache.get(operatorId);
    if (hit && hit.exp > now) return hit.ep;
    const ep = await fetcher(operatorId);
    cache.set(operatorId, { ep, exp: now + ttlMs });
    return ep;
  };
}
