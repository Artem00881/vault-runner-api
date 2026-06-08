import { MockOperator } from "./mock-operator";
import { OperatorInsufficientFunds } from "../../src/wallet/operator-wallet.types";

/**
 * A REAL HTTP operator wallet for end-to-end tests, served on an ephemeral port
 * via Bun.serve. It reuses {@link MockOperator} for the money bookkeeping
 * (balances, idempotency, exact rollback) but speaks the same JSON wire protocol
 * the production HttpOperatorWalletApi expects — so we can exercise the whole
 * call over a genuine socket, including the scary failure modes.
 *
 * One-shot misbehaviours (via `arm`) reproduce them at the transport level:
 *  - `{ delayMs }`                         → hang past the client timeout (the
 *                                            request never applied) → client abort.
 *  - `{ delayMs, applyBeforeDelay: true }` → APPLY the move, THEN hang → the
 *                                            classic "timeout-after-apply".
 *  - `{ status: 500 }`                     → hard operator error.
 */
export interface SandboxControls {
  delayMs?: number;
  applyBeforeDelay?: boolean;
  status?: number;
}

export interface SandboxOperator {
  url: string;
  operator: MockOperator;
  apiKey: string;
  arm(c: SandboxControls): void;
  /** Authorization header seen on the most recent request (to assert auth). */
  getLastAuth(): string | null;
  stop(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function startSandboxOperator(
  opts: { seed?: Record<string, number | bigint>; apiKey?: string } = {},
): SandboxOperator {
  const mock = new MockOperator(opts.seed ?? {});
  const apiKey = opts.apiKey ?? "sandbox-key";
  let armed: SandboxControls | null = null;
  let lastAuth: string | null = null;

  const doMove = (path: string, body: any) => {
    if (path === "bet") return mock.bet("op", body);
    if (path === "win") return mock.win("op", body);
    if (path === "rollback") return mock.rollback("op", body);
    throw new Error(`unknown path ${path}`);
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      lastAuth = req.headers.get("authorization");
      const path = new URL(req.url).pathname.replace(/^\/+/, "");
      const body = await req.json().catch(() => ({}));
      const ctl = armed;
      armed = null;

      if (ctl?.status) return json({ error: "boom" }, ctl.status);

      try {
        if (path === "balance") {
          const bal = await mock.balance("op", body.playerId, body.currency);
          return json({ balance: bal });
        }

        // Hang to force a client-side timeout. Optionally apply the move first
        // (operator DID change the balance but we never see the response).
        if (ctl?.delayMs != null) {
          if (ctl.applyBeforeDelay) await doMove(path, body);
          await sleep(ctl.delayMs);
          return json({ ok: true }); // client has aborted by now; response ignored
        }

        const res = await doMove(path, body);
        return json(res);
      } catch (e) {
        if (e instanceof OperatorInsufficientFunds) {
          return json({ error: "insufficient_funds" }, 402);
        }
        return json({ error: "operator_error" }, 500);
      }
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    operator: mock,
    apiKey,
    arm(c) {
      armed = c;
    },
    getLastAuth() {
      return lastAuth;
    },
    stop() {
      server.stop(true);
    },
  };
}
