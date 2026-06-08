import { Global, Module } from "@nestjs/common";
import { DataErasureService } from "./data-erasure.service";

/**
 * Privacy / data-protection (audit F-065 — GDPR erasure-as-anonymization). @Global (like
 * AuditModule / MetricsModule) so it can be injected anywhere later. It needs only the
 * global PrismaService + AuditEventService (+ optional MetricsService). No HTTP controller
 * is exposed yet (the anonymize path runs via the CLI; an operator-facing route inherits
 * the VOID route's prerequisites — see the roadmap deferred list).
 */
@Global()
@Module({
  providers: [DataErasureService],
  exports: [DataErasureService],
})
export class PrivacyModule {}
