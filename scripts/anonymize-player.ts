/**
 * GDPR data-erasure CLI (audit F-065) — anonymize ONE operator player IN PLACE.
 *
 *   DATABASE_URL=… bun scripts/anonymize-player.ts --operator-code demo-casino \
 *     --player-id player-42 [--currency EUR] [--reason "gdpr erasure request #123"]
 *
 *   # or address the operator by its UUID directly:
 *   DATABASE_URL=… bun scripts/anonymize-player.ts --operator-id <uuid> --player-id player-42
 *
 * Scrubs the player's PII (username tag, profile displayName, session playerId) and sets a
 * tombstone (User.anonymizedAt) while leaving EVERY money record — wallets, ledger
 * transactions, bets — byte-identical (F-017 makes those FKs RESTRICT; we never delete).
 * REFUSES if the player still has money in flight (a non-terminal bet or a live session) —
 * settle/void first. Idempotent: re-running on an already-anonymized player is a no-op.
 *
 * Standalone (no Nest DI): builds PrismaService + AuditEventService + DataErasureService
 * directly, the same shape Nest would wire. The audit row is best-effort (never throws).
 */
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditEventService } from "../src/audit/audit-event.service";
import { MetricsService } from "../src/metrics/metrics.service";
import { DataErasureService } from "../src/privacy/data-erasure.service";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const operatorId = str(args["operator-id"]);
  const operatorCode = str(args["operator-code"]);
  const playerId = str(args["player-id"]);

  if ((!operatorId && !operatorCode) || !playerId) {
    console.error(
      "usage: bun scripts/anonymize-player.ts (--operator-id <uuid> | --operator-code <code>) --player-id <id>\n" +
        "  [--currency EUR] [--reason '...']",
    );
    process.exit(1);
  }

  const prisma = new PrismaService();
  try {
    // Resolve operator by code → id if the UUID wasn't given directly.
    let opId = operatorId;
    if (!opId && operatorCode) {
      const op = await prisma.operator.findUnique({ where: { code: operatorCode }, select: { id: true } });
      if (!op) {
        console.error(`error: no operator with code "${operatorCode}"`);
        process.exit(1);
      }
      opId = op.id;
    }

    const metrics = new MetricsService();
    const audit = new AuditEventService(prisma, metrics);
    const erasure = new DataErasureService(prisma, audit, metrics);

    const result = await erasure.anonymizePlayer({
      operatorId: opId!,
      playerId: playerId!,
      currency: str(args.currency),
      actor: "provision-cli",
      reason: str(args.reason),
    });

    if (result.usersAffected === 0) {
      console.log(`NO-OP: no local user found for operator ${opId} player "${playerId}" (nothing to anonymize).`);
    } else if (result.alreadyAnonymized) {
      console.log(`ALREADY ANONYMIZED: ${result.usersAffected} user record(s) for operator ${opId} player "${playerId}" — no change.`);
    } else {
      console.log(`ANONYMIZED operator ${opId} player "${playerId}":`);
      console.log(`  user records scrubbed: ${result.usersAffected}`);
      console.log(`  fields scrubbed:       ${result.scrubbedFields.join(", ")}`);
      console.log(`  money records (wallets / ledger / bets): RETAINED, untouched.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) {
  main().catch((e: any) => {
    // A "player_not_settled" BadRequestException surfaces as a clean message, not a stack.
    console.error("error:", e?.response?.message ?? e?.message ?? e);
    process.exit(1);
  });
}
