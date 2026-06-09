import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../prisma/prisma.service";
import { bearerToken } from "../common/timing-safe";
import { extractClientIp } from "../common/client-ip";
import { parseReportingToken, reportingKeyPepperUnavailable, verifyReportingSecret } from "./reporting-key";

/** Metadata key set by @RequireWriteScope() — read by OperatorAuthGuard to decide which key
 *  scope a route demands. */
export const OPERATOR_WRITE_SCOPE = "operator:write-scope";

/**
 * Mark an operator route (or whole controller) as requiring the WRITE-scope key (write-route
 * shared gate). Without this, a route is treated as READ scope and accepts the reporting key
 * exactly as before (100% back-compat). With it, the request must present a key that matches the
 * operator's `writeApiKeyHash`; if that column is null the route is DENIED (fail-closed) — an
 * operator must be explicitly provisioned a write key. Apply to the money/state-MOVING operator
 * routes: bet-void, session-revoke, and the upcoming GDPR-erasure write route.
 */
export const RequireWriteScope = () => SetMetadata(OPERATOR_WRITE_SCOPE, true);

/**
 * Authenticates an inbound OPERATOR (B2B) request via a per-operator API key
 * (`Authorization: Bearer vrk_<operatorId>.<secret>` for read, `vrw_…` for write; see
 * reporting-key.ts). On success, attaches `req.operatorId` (read it ONLY via @CurrentOperatorId)
 * — the tenant scope for every reporting query. NEVER trust an operatorId from the query or body.
 * (Phase 3.5)
 *
 * SCOPE (write-route shared gate): READ routes (the default) verify the presented secret against
 * `Operator.reportingApiKeyHash` — unchanged, back-compatible. WRITE routes (marked with
 * @RequireWriteScope) verify against `Operator.writeApiKeyHash` instead, and FAIL CLOSED when that
 * column is null (no write key provisioned). The decision is driven by the route's metadata, never
 * by the token prefix — so a read key can never satisfy a write route.
 *
 * Posture differs DELIBERATELY from MetricsAuthGuard's "unset = open": there is no
 * open path here — a missing/invalid/wrong-scope key is always 401. All auth failures return the
 * same generic shapes (invalid_api_key / operator_disabled) — no "exists but wrong
 * key" oracle, and no oracle distinguishing "wrong key" from "lacks write scope".
 */
@Injectable()
export class OperatorAuthGuard implements CanActivate {
  private readonly log = new Logger(OperatorAuthGuard.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const requireWrite =
      this.reflector.getAllAndOverride<boolean>(OPERATOR_WRITE_SCOPE, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) === true;

    const parsed = parseReportingToken(bearerToken(req?.headers?.authorization));
    if (!parsed) throw new UnauthorizedException("invalid_api_key");

    // Lookup by the non-secret operatorId prefix (parseReportingToken already
    // validated it's a UUID, so this never throws on bad input).
    const operator = await this.prisma.operator.findUnique({ where: { id: parsed.operatorId } });
    // Verify against the hash for the ROUTE's scope: write routes require writeApiKeyHash, read
    // routes the reporting hash. verifyReportingSecret hashes UNCONDITIONALLY (flattens both the
    // not-found and the "scope hash is null" timing — no oracle for "operator exists but has no
    // write key").
    const storedHash = requireWrite ? operator?.writeApiKeyHash ?? null : operator?.reportingApiKeyHash ?? null;
    const ok = verifyReportingSecret(parsed.secret, storedHash);
    if (!operator || !ok) {
      // Surface a pepper-drift outage distinctly (security M-1): a peppered key can't
      // be verified while REPORTING_KEY_PEPPER is unset → every request 401s. This is
      // a config error, not a wrong key — make it diagnosable instead of silent. (Checks the
      // SAME scope's hash that was used above, so a write-route drift is reported too.)
      if (operator && reportingKeyPepperUnavailable(storedHash)) {
        this.log.warn(
          `operator ${operator.id}: ${requireWrite ? "write" : "reporting"} key is peppered but REPORTING_KEY_PEPPER is unset — auth will fail until the pepper is restored`,
        );
      }
      throw new UnauthorizedException("invalid_api_key");
    }
    if (!operator.enabled) throw new UnauthorizedException("operator_disabled");

    // Optional second factor: when the operator has an ipWhitelist configured, the
    // caller's IP must be in it (fail-closed). Empty list → skipped (back-compat).
    if (operator.ipWhitelist.length > 0) {
      const ip = extractClientIp(req);
      if (!operator.ipWhitelist.includes(ip)) throw new UnauthorizedException("ip_not_allowed");
    }

    req.operatorId = operator.id;
    return true;
  }
}

/** Inject the authenticated operatorId resolved by OperatorAuthGuard. Fails CLOSED:
 *  if this is ever used on a route NOT behind OperatorAuthGuard, req.operatorId is
 *  unset → throw rather than letting `where:{operatorId:undefined}` become an
 *  all-tenant scan (security hardening, GLI pre-empt). */
export const CurrentOperatorId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const operatorId = ctx.switchToHttp().getRequest().operatorId;
  if (!operatorId) throw new UnauthorizedException("operator_not_resolved");
  return operatorId;
});
