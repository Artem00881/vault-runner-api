/**
 * Dev helper: mint a one-time operator launch token (the proper, supported
 * replacement for ad-hoc throwaway scripts). Signs with the operator's own
 * launchSecret via the production LaunchTokenService.
 *
 *   DATABASE_URL=… JWT_SECRET=x bun scripts/operator-launch-token.ts \
 *     --code demo-casino --player player-123 --currency EUR [--locale en]
 *
 * Prints LAUNCH_TOKEN=… and a ready ?launch_token=… URL. The token is short-lived
 * (~2 min) and one-time — mint right before you use it. NB: the currency must be
 * in the operator's allowed list or the launch will be rejected (currency_not_allowed).
 */
import { PrismaClient } from "@prisma/client";
import { JwtService } from "@nestjs/jwt";
import { LaunchTokenService } from "../src/operator/launch-token.service";

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
  const code = str(args.code);
  if (!code) {
    console.error(
      "usage: bun scripts/operator-launch-token.ts --code <operatorCode> --player <id> --currency <CCY> [--locale en] [--demo]",
    );
    process.exit(1);
  }
  const playerId = str(args.player) ?? "dev-player-1";
  const currency = str(args.currency) ?? "DEMO";
  const locale = str(args.locale) ?? "en";
  const demo = args.demo === true; // play-money "fun mode" launch

  const prisma = new PrismaClient();
  try {
    const op = await prisma.operator.findUnique({ where: { code } });
    if (!op) {
      console.error(`no operator with code "${code}" — run scripts/operator-provision.ts first`);
      process.exit(1);
    }
    const svc = new LaunchTokenService(new JwtService({}) as any, prisma as any);
    const token = await svc.issue({ operatorId: op.id, playerId, currency, locale, demo });
    const base = process.env.WEB_BASE_URL ?? "https://vaultrun.app";
    console.log("LAUNCH_TOKEN=" + token);
    console.log("URL=" + base + "/?launch_token=" + token);
    if (!op.currencies.includes(currency)) {
      console.error(
        `\n⚠ currency "${currency}" is NOT in operator.currencies [${op.currencies.join(", ") || "none"}] — this launch will be rejected (currency_not_allowed).`,
      );
    }
    if (demo && !op.demoEnabled) {
      console.error(
        `\n⚠ --demo requested but operator "${code}" has demoEnabled=false — this launch will be rejected (demo_not_allowed).\n` +
          `  enable with: bun scripts/operator-provision.ts --code ${code} --demo-enabled`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
