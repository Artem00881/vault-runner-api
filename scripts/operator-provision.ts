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
import { validateRgConfig, type RgConfig } from "../src/operator/rg-config";

/** Uppercase every top-level key of a record (currency-code canonicalisation).
 *  Throws on a case-collision (e.g. {"eur","EUR"}) so a malformed config fails loudly
 *  at write time rather than silently dropping a limit table (last-wins). */
function upperKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) {
    const K = k.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(out, K)) {
      throw new Error(`config has case-colliding currency keys mapping to "${K}" — use one canonical code`);
    }
    out[K] = v;
  }
  return out;
}

/** Uppercase the per-currency keys nested under an rgConfig's `limits` map (the
 *  top-level RG keys — interval/maxSessionSec/enforce — are NOT currencies, so they
 *  are left untouched). Reuses upperKeys' case-collision guard. */
function upperKeysRgLimits(cfg: RgConfig): RgConfig {
  return cfg.limits ? { ...cfg, limits: upperKeys(cfg.limits) } : cfg;
}

export interface ProvisionInput {
  code: string;
  name?: string;
  currencies?: string[];
  walletApiUrl?: string;
  walletApiKey?: string;
  betLimits?: unknown; // validated against BetLimitsSchema before write
  rgConfig?: unknown; // validated against RgConfigSchema before write (responsible gambling)
  ipWhitelist?: string[];
  callbackUrl?: string;
  enabled?: boolean;
  demoEnabled?: boolean; // may this operator launch play-money "fun mode"? (off by default)
  rotateSecret?: boolean;
}

/** Create or update an operator (upsert by code). Returns the row, whether it was
 *  created, and the launchSecret ONLY when freshly generated (create or rotate). */
export async function provisionOperator(
  prisma: Pick<PrismaClient, "operator">,
  input: ProvisionInput,
): Promise<{ operator: any; created: boolean; launchSecret?: string }> {
  // Canonicalise currency codes to UPPERCASE (ISO-4217) on write so the launch-time
  // allow-list check and the per-currency limit lookup (both case-insensitive /
  // uppercased) always match what the operator stored.
  const betLimits =
    input.betLimits !== undefined ? upperKeys(validateBetLimits(input.betLimits)) : undefined;
  const rgConfig =
    input.rgConfig !== undefined ? upperKeysRgLimits(validateRgConfig(input.rgConfig)) : undefined;
  const currencies = input.currencies?.map((c) => c.toUpperCase());

  const existing = await prisma.operator.findUnique({ where: { code: input.code } });
  const created = !existing;
  const newSecret = randomBytes(32).toString("hex");

  // Fields to set on UPDATE — only the ones explicitly provided (others untouched).
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (currencies !== undefined) patch.currencies = currencies;
  if (input.walletApiUrl !== undefined) patch.walletApiUrl = input.walletApiUrl;
  if (input.walletApiKey !== undefined) patch.walletApiKey = input.walletApiKey;
  if (input.callbackUrl !== undefined) patch.callbackUrl = input.callbackUrl;
  if (input.ipWhitelist !== undefined) patch.ipWhitelist = input.ipWhitelist;
  if (betLimits !== undefined) patch.betLimits = betLimits as object;
  if (rgConfig !== undefined) patch.rgConfig = rgConfig as object;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.demoEnabled !== undefined) patch.demoEnabled = input.demoEnabled;
  if (input.rotateSecret) patch.launchSecret = newSecret;

  const operator = await prisma.operator.upsert({
    where: { code: input.code },
    create: {
      code: input.code,
      name: input.name ?? input.code,
      launchSecret: newSecret,
      enabled: input.enabled ?? true,
      demoEnabled: input.demoEnabled ?? false,
      currencies: currencies ?? [],
      walletApiUrl: input.walletApiUrl ?? null,
      walletApiKey: input.walletApiKey ?? null,
      callbackUrl: input.callbackUrl ?? null,
      ipWhitelist: input.ipWhitelist ?? [],
      ...(betLimits !== undefined ? { betLimits: betLimits as object } : {}),
      ...(rgConfig !== undefined ? { rgConfig: rgConfig as object } : {}),
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
        "  [--wallet-url ..] [--wallet-key ..] [--bet-limits '<json>'|@file.json] [--rg-config '<json>'|@file.json]\n" +
        "  [--ip-whitelist a,b] [--callback-url ..] [--disabled] [--demo-enabled|--demo-disabled] [--rotate-secret]",
    );
    process.exit(1);
  }

  let betLimits: unknown;
  const bl = str(args["bet-limits"]);
  if (bl) {
    const raw = bl.startsWith("@") ? await Bun.file(bl.slice(1)).text() : bl;
    betLimits = JSON.parse(raw);
  }

  let rgConfig: unknown;
  const rgc = str(args["rg-config"]);
  if (rgc) {
    const raw = rgc.startsWith("@") ? await Bun.file(rgc.slice(1)).text() : rgc;
    rgConfig = JSON.parse(raw);
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
      rgConfig,
      ipWhitelist: list(args["ip-whitelist"]),
      callbackUrl: str(args["callback-url"]),
      enabled: args.disabled ? false : undefined,
      demoEnabled:
        args["demo-enabled"] === true ? true : args["demo-disabled"] === true ? false : undefined,
      rotateSecret: args["rotate-secret"] === true,
    });

    console.log(`${created ? "CREATED" : "UPDATED"} operator ${operator.code} (id ${operator.id})`);
    console.log(
      `  currencies: ${operator.currencies.join(", ") || "(NONE — every launch will be rejected until you set --currencies!)"}`,
    );
    console.log(`  walletApiUrl: ${operator.walletApiUrl ?? "(none)"}`);
    console.log(`  betLimits: ${operator.betLimits ? JSON.stringify(operator.betLimits) : "(none → global env defaults)"}`);
    console.log(`  rgConfig: ${operator.rgConfig ? JSON.stringify(operator.rgConfig) : "(none → no in-session RG)"}`);
    console.log(`  enabled: ${operator.enabled}`);
    console.log(`  demoEnabled: ${operator.demoEnabled} (play-money fun mode)`);
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
      console.error("invalid config (--bet-limits / --rg-config):");
      for (const i of e.issues) console.error(`  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    } else {
      console.error("error:", e?.message ?? e);
    }
    process.exit(1);
  });
}
