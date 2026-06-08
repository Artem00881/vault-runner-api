import { Controller, Get, UseGuards } from "@nestjs/common";
import { MetricsAuthGuard } from "./metrics-auth.guard";
import { buildInfo } from "../common/build-info";

/**
 * Build/version traceability (audit F-059): GET /version reports the running build's
 * service, package version, git commit and build time so a live node can be traced
 * back to an exact source revision (a GLI ask).
 *
 * Gated behind the SAME MetricsAuthGuard as /metrics (NOT anonymous) — the commit/build
 * identity is operational info, not public. Posture matches /metrics: when METRICS_TOKEN
 * is UNSET the route is open (local/dev/CI); when SET it requires the bearer.
 */
@Controller("version")
@UseGuards(MetricsAuthGuard)
export class VersionController {
  @Get()
  version() {
    return buildInfo();
  }
}
