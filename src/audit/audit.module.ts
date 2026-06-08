import { Global, Module } from "@nestjs/common";
import { AuditEventService } from "./audit-event.service";

/**
 * Significant-event AUDIT LOG (F-058). @Global (like PrismaModule / MetricsModule) so
 * any feature module — game (bet void), fairness (RNG epoch/salt), operator (session
 * revoke) — can inject AuditEventService without per-module import wiring. It needs only
 * the global PrismaService + MetricsService.
 */
@Global()
@Module({
  providers: [AuditEventService],
  exports: [AuditEventService],
})
export class AuditModule {}
