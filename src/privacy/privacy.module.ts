import { Global, Module } from "@nestjs/common";
import { OperatorModule } from "../operator/operator.module";
import { DataErasureService } from "./data-erasure.service";
import { OperatorErasureController } from "./operator-erasure.controller";

/**
 * Privacy / data-protection (audit F-065 — GDPR erasure-as-anonymization). @Global (like
 * AuditModule / MetricsModule) so DataErasureService can be injected anywhere. It needs only the
 * global PrismaService + AuditEventService (+ optional MetricsService).
 *
 * Exposes the operator-facing erasure route (R-039): `POST /api/operator/players/:playerId/erase`,
 * behind the write-route shared gate. Imports OperatorModule (no cycle — OperatorModule does NOT
 * depend on PrivacyModule) to reuse the exported OperatorAuthGuard + OperatorThrottlerGuard, so the
 * route gets the SAME per-operator key auth, tenant scoping, write-key scope, and per-operator
 * write rate-limit as the bet-void / session-revoke routes. The CLI (scripts/anonymize-player.ts)
 * and the retention sweep (scripts/retention-sweep.ts) call DataErasureService directly.
 */
@Global()
@Module({
  imports: [OperatorModule],
  controllers: [OperatorErasureController],
  providers: [DataErasureService],
  exports: [DataErasureService],
})
export class PrivacyModule {}
