import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsService } from "../metrics/metrics.service";

/**
 * Object keys whose lowercased name CONTAINS any of these substrings have their VALUE
 * redacted by sanitizeAuditPayload (defense-in-depth — callers already scrub). The KEY
 * is kept so it stays visible that the field was present. Deliberately does NOT match
 * saltHash / commitHash / hashPrefix (those are public provably-fair artifacts).
 */
const REDACT_KEY_SUBSTRINGS = [
  "secret",
  "password",
  "passwd",
  "token",
  "apikey",
  "api_key",
  "walletapikey",
  "privatekey",
  "private_key",
  "launchsecret",
] as const;

/** Max serialized size for a single audit field; over this we store a stub, not the blob. */
const MAX_AUDIT_FIELD_BYTES = 16384;

/**
 * Defense-in-depth scrubber for a single audit field (`before` / `after` / `meta`).
 * Deep-walks objects/arrays, redacts secret-looking VALUES (keeping the key), and caps
 * the serialized size. Pure, null/undefined/primitive-safe, and NEVER throws — record()
 * is best-effort, so a malformed payload must not break the audit write.
 */
export function sanitizeAuditPayload(v: unknown): unknown {
  let scrubbed: unknown;
  try {
    scrubbed = scrub(v, new WeakSet<object>());
  } catch {
    // Pathological input (e.g. a getter that throws): degrade gracefully, never throw.
    return { truncated: true, bytes: -1 };
  }
  // Size guard: a single field that serializes huge is replaced with a stub. (Self-referential
  // cycles are already broken by scrub() — the WeakSet replaces a revisit with "[circular]".)
  try {
    const json = JSON.stringify(scrubbed);
    if (json !== undefined && json.length > MAX_AUDIT_FIELD_BYTES) {
      return { truncated: true, bytes: json.length };
    }
  } catch {
    return { truncated: true, bytes: -1 };
  }
  return scrubbed;
}

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return REDACT_KEY_SUBSTRINGS.some((s) => k.includes(s));
}

function scrub(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value; // primitives & null pass through
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => scrub(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? "[redacted]" : scrub(val, seen);
  }
  return out;
}

/** A significant event to append to the immutable audit log (F-058). */
export interface AuditEventInput {
  actor: string; // who: "operator:<id>" | "system" | "provision-cli" | "engine" | "reconciler"
  action: string; // dotted verb, e.g. "operator.bet_void" | "rng.salt_fallback"
  targetType?: string; // "bet" | "operator" | "game_session" | "rng_epoch" | ...
  targetId?: string;
  operatorId?: string;
  ip?: string;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
}

/**
 * Unified significant-event AUDIT LOG writer (audit F-058) — the "who did what, when"
 * trail GLI-19 expects alongside the money ledger and the provably-fair seed chain.
 * Writes ONE append-only `AuditEvent` row per call.
 *
 * BEST-EFFORT BY DESIGN: an audit-write failure must NEVER break a money / operator /
 * fairness action (that would be worse than a missing log line). `record()` therefore
 * swallows any error — it logs it AND bumps `vaultrun_audit_event_write_failures_total`
 * (so a dropped-events condition is loud + alertable) and never rethrows. Callers may
 * `await` it without a try/catch.
 *
 * The table is APPEND-ONLY: this service deliberately exposes NO update/delete method,
 * and prod REVOKEs UPDATE/DELETE on the table from the app DB role (see the migration /
 * DEPLOY.md). Secret values are NEVER passed in `before/after/meta` (callers log only a
 * non-secret hash prefix for key events).
 */
@Injectable()
export class AuditEventService {
  private readonly log = new Logger(AuditEventService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async record(e: AuditEventInput): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actor: e.actor,
          action: e.action,
          targetType: e.targetType ?? null,
          targetId: e.targetId ?? null,
          operatorId: e.operatorId ?? null,
          ip: e.ip ?? null,
          // Prisma's Json input type is intentionally loose; cast at the boundary. A
          // value of `undefined` omits the column; we normalise to skip JSON null noise.
          // sanitizeAuditPayload is a defense-in-depth net (callers already scrub secrets):
          // it redacts secret-looking keys and caps oversized fields.
          before: (e.before == null ? undefined : sanitizeAuditPayload(e.before)) as any,
          after: (e.after == null ? undefined : sanitizeAuditPayload(e.after)) as any,
          meta: (e.meta == null ? undefined : sanitizeAuditPayload(e.meta)) as any,
        },
      });
    } catch (err) {
      // Never let an audit-write failure propagate into a money/operator/fairness path.
      this.metrics.recordError("audit_event_write");
      this.metrics.auditEventWriteFailures.inc();
      this.log.error(
        `audit event write FAILED (best-effort, not rethrown) action=${e.action} actor=${e.actor}: ${String(err)}`,
      );
    }
  }
}
