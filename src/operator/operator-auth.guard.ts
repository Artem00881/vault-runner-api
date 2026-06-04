import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { bearerToken } from "../common/timing-safe";
import { extractClientIp } from "../common/client-ip";
import { parseReportingToken, reportingKeyPepperUnavailable, verifyReportingSecret } from "./reporting-key";

/**
 * Authenticates an inbound OPERATOR (B2B) request via the per-operator reporting
 * API key (`Authorization: Bearer vrk_<operatorId>.<secret>`, see reporting-key.ts).
 * On success, attaches `req.operatorId` (read it ONLY via @CurrentOperatorId) — the
 * tenant scope for every reporting query. NEVER trust an operatorId from the query
 * or body. (Phase 3.5)
 *
 * Posture differs DELIBERATELY from MetricsAuthGuard's "unset = open": there is no
 * open path here — a missing/invalid key is always 401. All auth failures return the
 * same generic shapes (invalid_api_key / operator_disabled) — no "exists but wrong
 * key" oracle.
 */
@Injectable()
export class OperatorAuthGuard implements CanActivate {
  private readonly log = new Logger(OperatorAuthGuard.name);
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const parsed = parseReportingToken(bearerToken(req?.headers?.authorization));
    if (!parsed) throw new UnauthorizedException("invalid_api_key");

    // Lookup by the non-secret operatorId prefix (parseReportingToken already
    // validated it's a UUID, so this never throws on bad input).
    const operator = await this.prisma.operator.findUnique({ where: { id: parsed.operatorId } });
    // verifyReportingSecret hashes unconditionally (flattens not-found timing).
    const ok = verifyReportingSecret(parsed.secret, operator?.reportingApiKeyHash ?? null);
    if (!operator || !ok) {
      // Surface a pepper-drift outage distinctly (security M-1): a peppered key can't
      // be verified while REPORTING_KEY_PEPPER is unset → every request 401s. This is
      // a config error, not a wrong key — make it diagnosable instead of silent.
      if (operator && reportingKeyPepperUnavailable(operator.reportingApiKeyHash)) {
        this.log.warn(
          `operator ${operator.id}: reporting key is peppered but REPORTING_KEY_PEPPER is unset — reporting auth will fail until the pepper is restored`,
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
