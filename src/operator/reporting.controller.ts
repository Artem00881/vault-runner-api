import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { CurrentOperatorId, OperatorAuthGuard } from "./operator-auth.guard";
import { OperatorThrottlerGuard } from "./operator-throttler.guard";
import { ReportingService } from "./reporting.service";
import { parseBetsQuery, parseDailyQuery, parseReportQuery, parseTransactionQuery } from "./reporting-query";

/**
 * Operator REPORTING (B2B) surface (Phase 3.5). Every route is authenticated by the
 * per-operator reporting API key (OperatorAuthGuard) and scoped to that operator —
 * the operatorId is taken ONLY from @CurrentOperatorId, never from the query/body.
 *
 *   GET /api/operator/reports/summary?from&to[&currency][&includeDemo]
 *   GET /api/operator/reports/daily  ?from&to[&currency][&includeDemo]
 *   GET /api/operator/reports/bets   ?from&to[&currency][&includeDemo][&cursor][&limit]
 *   GET /api/operator/reports/transaction?transactionId=…  | ?betId=…   (single-tx status, Phase 6)
 */
// READ scope (no @RequireWriteScope): the reporting key authorizes these. OperatorThrottlerGuard
// runs AFTER OperatorAuthGuard so it keys the per-operator read budget by the resolved operatorId.
@Controller("api/operator/reports")
@UseGuards(OperatorAuthGuard, OperatorThrottlerGuard)
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get("summary")
  async summary(@CurrentOperatorId() operatorId: string, @Query() query: unknown) {
    return this.reporting.summary(operatorId, parseReportQuery(query));
  }

  @Get("daily")
  async daily(@CurrentOperatorId() operatorId: string, @Query() query: unknown) {
    return this.reporting.daily(operatorId, parseDailyQuery(query));
  }

  @Get("bets")
  async bets(@CurrentOperatorId() operatorId: string, @Query() query: unknown) {
    return this.reporting.bets(operatorId, parseBetsQuery(query));
  }

  // Single-transaction status lookup (Phase 6) — by our betId or the transactionId we
  // sent on a wallet call. Tenant-scoped; a tx that isn't this operator's → 404.
  @Get("transaction")
  async transaction(@CurrentOperatorId() operatorId: string, @Query() query: unknown) {
    return this.reporting.transactionStatus(operatorId, parseTransactionQuery(query));
  }
}
