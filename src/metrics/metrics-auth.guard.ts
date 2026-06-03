import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { bearerToken, safeTokenEqual } from "../common/timing-safe";

/**
 * Guards `/metrics` with a static bearer token (env `METRICS_TOKEN`) — the
 * exposition leaks bet/payout/RTP volumes (audit H5).
 *  - UNSET → ALLOW (open): keeps local dev / CI / unit tests working without new
 *    env. The origin is reachable only via Cloudflare/Caddy or the internal
 *    Docker network (the app binds loopback), so this is not an open-internet
 *    hole; prod SETS the token (1Password) to actually lock it.
 *  - SET → require `Authorization: Bearer <METRICS_TOKEN>` (constant-time compare).
 *    Prometheus is configured with the matching bearer (credentials_file).
 */
@Injectable()
export class MetricsAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.METRICS_TOKEN;
    if (!expected) return true; // unset = open (see above)
    const req = ctx.switchToHttp().getRequest();
    const token = bearerToken(req?.headers?.authorization);
    if (!safeTokenEqual(token, expected)) throw new UnauthorizedException("metrics_unauthorized");
    return true;
  }
}
