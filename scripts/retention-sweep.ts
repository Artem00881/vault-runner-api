/**
 * GDPR retention sweep (R-038) — anonymize operator players whose sessions have been DORMANT
 * past a configurable retention window. The automated, batch complement to the per-player
 * `scripts/anonymize-player.ts`. Run it on a CRON (weekly) — see DEPLOY.md.
 *
 *   # DRY-RUN (default — lists who WOULD be erased, mutates NOTHING):
 *   DATABASE_URL=… RETENTION_DAYS=365 bun scripts/retention-sweep.ts
 *
 *   # APPLY (actually anonymize the listed players):
 *   DATABASE_URL=… RETENTION_DAYS=365 bun scripts/retention-sweep.ts --apply
 *
 *   # other flags:
 *   --days <n>          override RETENTION_DAYS for this run (CLI wins over the env)
 *   --operator-code <c> restrict to ONE operator (by Operator.code)
 *   --limit <n>         cap how many players are anonymized this run (apply mode; default: all)
 *
 * SAFETY (all inherited from DataErasureService — this script adds no new money path):
 *  - DRY-RUN BY DEFAULT. Nothing is mutated unless `--apply` is passed. Always dry-run first.
 *  - "Dormant" = the player's MOST RECENT activity (last session launch OR last bet across all
 *    their wallets) is strictly older than now − RETENTION_DAYS. Conservative: a player with even
 *    one recent session or bet is excluded. (We do NOT use GameSession.lastSeenAt — it is
 *    @updatedAt but never written, audit M-C2.2, so it's not a reliable recency signal.)
 *  - The actual scrub goes through DataErasureService.anonymizePlayer, which (a) RETAINS the entire
 *    money journal — wallets / ledger / bets are byte-identical (F-017 RESTRICT; we never delete),
 *    and (b) FAILS CLOSED on a player with money still in flight (a non-terminal bet or a live
 *    session): that player is SKIPPED (logged `player_not_settled`), never force-erased.
 *  - IDEMPOTENT: an already-anonymized player is filtered out of the candidate list, and a
 *    re-anonymize is in any case a no-op.
 *
 * The RETENTION WINDOW is a policy/DPA decision — set RETENTION_DAYS to whatever the operator
 * agreement requires (default 365). Standalone (no Nest DI): builds PrismaService +
 * AuditEventService + MetricsService + DataErasureService directly, the same shape Nest wires.
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

/** Resolve the retention window in days: --days wins, else RETENTION_DAYS, else 365.
 *  Must be a finite integer >= 1 (a 0/negative/NaN window would erase EVERYONE → refuse). */
function resolveRetentionDays(args: Record<string, string | boolean>): number {
  const raw = str(args.days) ?? process.env.RETENTION_DAYS;
  if (raw === undefined) return 365;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`invalid retention window "${raw}" — RETENTION_DAYS/--days must be an integer >= 1`);
  }
  return n;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.apply === true;
  const days = resolveRetentionDays(args);
  const operatorCode = str(args["operator-code"]);
  const limitRaw = str(args.limit);
  const limit = limitRaw !== undefined && Number.isInteger(Number(limitRaw)) && Number(limitRaw) >= 0 ? Number(limitRaw) : undefined;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const prisma = new PrismaService();
  try {
    // Optional operator scope: resolve a code → id used to filter the candidate list.
    let onlyOperatorId: string | undefined;
    if (operatorCode) {
      const op = await prisma.operator.findUnique({ where: { code: operatorCode }, select: { id: true } });
      if (!op) {
        console.error(`error: no operator with code "${operatorCode}"`);
        process.exit(1);
      }
      onlyOperatorId = op.id;
    }

    const metrics = new MetricsService();
    const audit = new AuditEventService(prisma, metrics);
    const erasure = new DataErasureService(prisma, audit, metrics);

    let candidates = await erasure.findDormantPlayers(cutoff);
    if (onlyOperatorId) candidates = candidates.filter((c) => c.operatorId === onlyOperatorId);

    console.log(
      `retention sweep — window=${days}d (cutoff ${cutoff.toISOString()})` +
        `${onlyOperatorId ? ` operator=${operatorCode}` : ""} mode=${apply ? "APPLY" : "DRY-RUN"}`,
    );
    console.log(`dormant players found: ${candidates.length}`);

    if (candidates.length === 0) {
      console.log("nothing to do.");
      await prisma.$disconnect();
      process.exit(0);
    }

    // DRY-RUN: list WHO would be erased (operatorId + last activity), mutate nothing. We do NOT
    // print the raw playerId in apply mode's audit, but the dry-run report is an operator-run
    // local tool, so it shows the playerId so the operator can sanity-check before applying.
    if (!apply) {
      for (const c of candidates) {
        console.log(`  WOULD ERASE  operator=${c.operatorId} player="${c.playerId}"  lastActivity=${c.lastActivity.toISOString()}`);
      }
      console.log(`\nDRY-RUN: ${candidates.length} player(s) WOULD be anonymized. Re-run with --apply to erase.`);
      await prisma.$disconnect();
      process.exit(0);
    }

    // APPLY: anonymize each candidate via the same fail-closed path. A player who became
    // non-settled between the scan and now (a fresh bet/session) is SKIPPED, not force-erased.
    const toProcess = limit !== undefined ? candidates.slice(0, limit) : candidates;
    let erased = 0;
    let skippedNotSettled = 0;
    let noop = 0;
    for (const c of toProcess) {
      try {
        const r = await erasure.anonymizePlayer({
          operatorId: c.operatorId,
          playerId: c.playerId,
          actor: "retention-sweep",
          reason: `retention sweep: dormant > ${days}d (last activity ${c.lastActivity.toISOString()})`,
        });
        if (r.usersAffected === 0 || r.alreadyAnonymized) {
          noop++;
        } else {
          erased++;
          console.log(`  ERASED  operator=${c.operatorId} player="${c.playerId}"  users=${r.usersAffected}`);
        }
      } catch (e: any) {
        const msg = e?.response?.message ?? e?.message ?? String(e);
        if (msg === "player_not_settled") {
          skippedNotSettled++;
          console.log(`  SKIP (money in flight)  operator=${c.operatorId} player="${c.playerId}"`);
        } else {
          // An unexpected error on ONE player must not abort the whole sweep — log + continue.
          console.error(`  ERROR  operator=${c.operatorId} player="${c.playerId}": ${msg}`);
        }
      }
    }

    console.log(
      `\nAPPLY complete — erased=${erased} no-op=${noop} skipped(in-flight)=${skippedNotSettled}` +
        `${limit !== undefined && candidates.length > toProcess.length ? ` (limited to ${limit} of ${candidates.length})` : ""}`,
    );
    await prisma.$disconnect();
    process.exit(0);
  } catch (e) {
    await prisma.$disconnect();
    throw e;
  }
}

if (import.meta.main) {
  main().catch((e: any) => {
    console.error("retention-sweep failed:", e?.response?.message ?? e?.message ?? e);
    process.exit(1);
  });
}
