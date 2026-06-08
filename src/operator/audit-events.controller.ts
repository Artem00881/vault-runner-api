import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { CurrentOperatorId, OperatorAuthGuard } from "./operator-auth.guard";
import { ReportingService } from "./reporting.service";
import { parseAuditQuery } from "./reporting-query";

/**
 * Operator-facing read of the significant-event AUDIT LOG (F-058). Authenticated by the
 * per-operator reporting API key (the SAME OperatorAuthGuard as the reporting surface)
 * and HARD-scoped to that operator — the operatorId comes ONLY from @CurrentOperatorId,
 * so an operator can read ONLY its own audit events (system/RNG rows stay internal).
 *
 *   GET /api/operator/audit-events[?action=…][&from&to][&limit]
 */
@Controller("api/operator/audit-events")
@UseGuards(OperatorAuthGuard)
export class AuditEventsController {
  constructor(private readonly reporting: ReportingService) {}

  @Get()
  async list(@CurrentOperatorId() operatorId: string, @Query() query: unknown) {
    return this.reporting.auditEvents(operatorId, parseAuditQuery(query));
  }
}
