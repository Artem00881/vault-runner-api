/**
 * Operator provisioning CLI (Phase 3 onboarding). Create or update an Operator
 * row — the repeatable replacement for a manual DB insert.
 *
 *   DATABASE_URL=… bun scripts/operator-provision.ts --code demo-casino \
 *     --name "Demo Casino" --currencies EUR,USDT \
 *     --wallet-url https://op.example/wallet --wallet-key SECRETKEY \
 *     --bet-limits '{"EUR":{"minBet":10,"maxBet":10000,"maxWinPerBet":1000000}}' \
 *     [--ip-whitelist 1.2.3.4,5.6.7.8] [--callback-url https://op.example/lobby] \
 *     [--disabled] [--rotate-secret]
 *
 * Upserts by --code. The launchSecret (the per-operator HMAC the operator signs
 * launch tokens with) is generated on CREATE and printed ONCE; on update it is
 * preserved unless --rotate-secret is passed (which invalidates outstanding
 * launch tokens). --bet-limits accepts inline JSON or @path/to/file.json.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { validateBetLimits } from "../src/operator/bet-limits";

export interface ProvisionInput {
  code: string;
  name?: string;
  currencies?: string[];
  walletApiUrl?: string;
  walletApiKey?: string;
  betLimits?: unknown; // validated against BetLimitsSchema before write
  ipWhitelist?: string[];
  callbackUrl?: string;
  enabled?: boolean;
  rotateSecret?: boolean;
}

/** Create or update an operator (upsert by code). Returns the row, whether it was
 *  created, and the launchSecret ONLY when freshly generated (create or rotate). */
export async function provisionOperator(
  prisma: Pick<PrismaClient, "operator">,
  input: ProvisionInput,
): Promise<{ operator: any; created: boolean; launchSecret?: string }> {
  const betLimits = input.betLimits !== undefined ? validateBetLimits(input.betLimits) : undefined;

  const existing = await prisma.operator.findUnique({ where: { code: input.code } });
  const created = !existing;
  const newSecret = randomBytes(32).toString("hex");

  // Fields to set on UPDATE — only the ones explicitly provided (others untouched).
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.currencies !== undefined) patch.currencies = input.currencies;
  if (input.walletApiUrl !== undefined) patch.walletApiUrl = input.walletApiUrl;
  if (input.walletApiKey !== undefined) patch.walletApiKey = input.walletApiKey;
  if (input.callbackUrl !== undefined) patch.callbackUrl = input.callbackUrl;
  if (input.ipWhitelist !== undefined) patch.ipWhitelist = input.ipWhitelist;
  if (betLimits !== undefined) patch.betLimits = betLimits as object;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.rotateSecret) patch.launchSecret = newSecret;

  const operator = await prisma.operator.upsert({
    where: { code: input.code },
    create: {
      code: input.code,
      name: input.name ?? input.code,
      launchSecret: newSecret,
      enabled: input.enabled ?? true,
      currencies: input.currencies ?? [],
      walletApiUrl: input.walletApiUrl ?? null,
      walletApiKey: input.walletApiKey ?? null,
      callbackUrl: input.callbackUrl ?? null,
      ipWhitelist: input.ipWhitelist ?? [],
      ...(betLimits !== undefined ? { betLimits: betLimits as object } : {}),
    },
    update: patch,
  });

  return {
    operator,
    created,
    launchSecret: created || input.rotateSecret ? operator.launchSecret : undefined,
  };
}

// ---- CLI ----
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

const list = (v: string | boolean | undefined) =>
  typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const code = str(args.code);
  if (!code) {
    console.error(
      "usage: bun scripts/operator-provision.ts --code <code> [--name ..] [--currencies EUR,USDT]\n" +
        "  [--wallet-url ..] [--wallet-key ..] [--bet-limits '<json>'|@file.json]\n" +
        "  [--ip-whitelist a,b] [--callback-url ..] [--disabled] [--rotate-secret]",
    );
    process.exit(1);
  }

  let betLimits: unknown;
  const bl = str(args["bet-limits"]);
  if (bl) {
    const raw = bl.startsWith("@") ? await Bun.file(bl.slice(1)).text() : bl;
    betLimits = JSON.parse(raw);
  }

  const prisma = new PrismaClient();
  try {
    const { operator, created, launchSecret } = await provisionOperator(prisma, {
      code,
      name: str(args.name),
      currencies: list(args.currencies),
      walletApiUrl: str(args["wallet-url"]),
      walletApiKey: str(args["wallet-key"]),
      betLimits,
      ipWhitelist: list(args["ip-whitelist"]),
      callbackUrl: str(args["callback-url"]),
      enabled: args.disabled ? false : undefined,
      rotateSecret: args["rotate-secret"] === true,
    });

    console.log(`${created ? "CREATED" : "UPDATED"} operator ${operator.code} (id ${operator.id})`);
    console.log(
      `  currencies: ${operator.currencies.join(", ") || "(NONE — every launch will be rejected until you set --currencies!)"}`,
    );
    console.log(`  walletApiUrl: ${operator.walletApiUrl ?? "(none)"}`);
    console.log(`  betLimits: ${operator.betLimits ? JSON.stringify(operator.betLimits) : "(none → global env defaults)"}`);
    console.log(`  enabled: ${operator.enabled}`);
    if (launchSecret) {
      console.log(`\n  launchSecret (${created ? "new" : "ROTATED — outstanding launch tokens are now invalid"}):`);
      console.log(`    ${launchSecret}`);
      console.log(`  ^ store securely (1Password) + share with the operator; it signs their launch tokens. Shown once.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) {
  main().catch((e: any) => {
    // Clean, operator-facing errors — no raw stack dump for a config typo.
    if (e?.name === "ZodError" && Array.isArray(e.issues)) {
      console.error("invalid --bet-limits:");
      for (const i of e.issues) console.error(`  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    } else {
      console.error("error:", e?.message ?? e);
    }
    process.exit(1);
  });
}
