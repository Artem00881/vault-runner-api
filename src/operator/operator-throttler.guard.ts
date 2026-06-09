import { ExecutionContext, Injectable } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerRequest } from "@nestjs/throttler";
import { extractClientIp } from "../common/client-ip";
import { OPERATOR_WRITE_SCOPE } from "./operator-auth.guard";

/**
 * Per-operator rate-limit for the B2B operator surface (write-route shared gate). The global
 * IpThrottlerGuard already caps by client IP, but an operator legitimately calls from a small,
 * stable set of server IPs — so an IP bucket is the WRONG dimension here (one busy operator could
 * starve another sharing an egress IP, or a single operator could hammer us from many IPs). This
 * guard keys the bucket by the AUTHENTICATED operatorId instead, with SEPARATE budgets for read
 * vs write routes.
 *
 * ORDERING: this runs AFTER OperatorAuthGuard (which sets req.operatorId) — guards on a route
 * execute in array order, so it is always listed second in @UseGuards. If operatorId is somehow
 * unset (guard misuse), we fall back to the client-IP tracker (still throttled, never fail-open).
 *
 * SCOPE BUDGETS (env-tunable; finite-guarded like GUEST_THROTTLE so a malformed/NaN env can never
 * silently DISABLE the limit — `hits > NaN` is always false = fail-open — and instead falls back
 * to the safe default):
 *   - read  routes: OPERATOR_READ_THROTTLE_LIMIT  / _TTL_MS  (default 600 / 60_000ms)
 *   - write routes: OPERATOR_WRITE_THROTTLE_LIMIT / _TTL_MS  (default  60 / 60_000ms)
 * Read and write keep DISTINCT storage buckets (the throttler's generateKey namespaces by
 * class+handler+throttler-name, and the two scopes additionally carry a distinct key suffix), so
 * a burst of reads can never consume the (much smaller) write budget or vice-versa.
 */

// Mirror AuthController's GUEST_THROTTLE finite-guard: a non-numeric / <1 / non-finite env falls
// back to the safe default instead of yielding NaN (which would fail-open-disable the throttle).
const numEnv = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt;
};

const READ_TTL_MS = numEnv(process.env.OPERATOR_READ_THROTTLE_TTL_MS, 60_000);
const READ_LIMIT = numEnv(process.env.OPERATOR_READ_THROTTLE_LIMIT, 600);
const WRITE_TTL_MS = numEnv(process.env.OPERATOR_WRITE_THROTTLE_TTL_MS, 60_000);
const WRITE_LIMIT = numEnv(process.env.OPERATOR_WRITE_THROTTLE_LIMIT, 60);

@Injectable()
export class OperatorThrottlerGuard extends ThrottlerGuard {
  /** Key the bucket by the authenticated operatorId (set by OperatorAuthGuard, which runs first).
   *  Fall back to the real client IP if it's somehow unset — still throttled, never fail-open. */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const operatorId = req?.operatorId;
    if (typeof operatorId === "string" && operatorId) return `op:${operatorId}`;
    return `ip:${extractClientIp(req)}`;
  }

  /** Inject the scope-aware ttl/limit (read vs write) and a scope-distinct key suffix so the two
   *  budgets never share a bucket. Everything else (storage increment, headers, 429) is the base
   *  ThrottlerGuard's behaviour. */
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const requireWrite =
      this.reflector.getAllAndOverride<boolean>(OPERATOR_WRITE_SCOPE, [
        requestProps.context.getHandler(),
        requestProps.context.getClass(),
      ]) === true;

    const ttl = requireWrite ? WRITE_TTL_MS : READ_TTL_MS;
    const limit = requireWrite ? WRITE_LIMIT : READ_LIMIT;
    const scope = requireWrite ? "w" : "r";

    return super.handleRequest({
      ...requestProps,
      ttl,
      limit,
      blockDuration: ttl,
      // Namespace the storage key by scope so read and write keep separate buckets even though
      // they share this one guard/throttler name.
      generateKey: (context, tracker, throttlerName) =>
        `${requestProps.generateKey(context, tracker, throttlerName)}:${scope}`,
    });
  }
}
