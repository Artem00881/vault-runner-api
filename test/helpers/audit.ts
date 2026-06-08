import { AuditEventService } from "../../src/audit/audit-event.service";
import { MetricsService } from "../../src/metrics/metrics.service";

/**
 * Build a REAL AuditEventService for unit tests that construct BetsService /
 * FairnessService / GameSessionService directly (outside Nest DI). It only needs a
 * PrismaService-shaped client + a MetricsService; record() is best-effort (never
 * throws), so passing a real one keeps the audit writes exercised in-suite (the rows
 * land in the test DB) without any test having to care about them.
 *
 * `prisma` is typed loosely (the tests use various prisma stand-ins / wrappers) — the
 * service only calls `prisma.auditEvent.create`, which is present on the generated client.
 */
export function makeAudit(prisma: any, metrics: MetricsService = new MetricsService()): AuditEventService {
  return new AuditEventService(prisma, metrics);
}
