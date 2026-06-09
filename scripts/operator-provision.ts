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
import { generateReportingKey, generateWriteKey } from "../src/operator/reporting-key";
import { isKnownCurrency } from "../src/common/currency";
import { readFileSync } from "node:fs";

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

/** Validate an operator callbackUrl (return-to-lobby) is a real http(s) URL, so a
 *  typo can't silently store a broken link. THROWS on invalid (Phase 3 go-live). */
function validateCallbackUrl(u: string): void {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error(`callbackUrl is not a valid URL: ${u}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`callbackUrl must be an http(s) URL: ${u}`);
  }
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
  rotateReportingKey?: boolean; // mint/rotate the inbound READ (reporting) api key (Phase 3.5)
  rotateWriteKey?: boolean; // mint/rotate the inbound WRITE api key — void/revoke/erasure (write-route shared gate)
  strictCurrencies?: boolean; // Phase 3.6: throw (not warn) if a currency isn't in the canonical table
}

/** Append a significant-event audit row (F-058) from the CLI. Best-effort + standalone
 *  (no Nest DI here): writes directly via the same PrismaClient the script already uses,
 *  and NEVER throws — a provision must not fail because its audit line didn't land.
 *  NEVER pass a secret value in before/after/meta (key rotation logs only a hash prefix). */
async function recordAudit(
  prisma: Pick<PrismaClient, "auditEvent">,
  e: { action: string; targetId?: string; operatorId?: string; before?: unknown; after?: unknown; meta?: unknown },
): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        actor: "provision-cli",
        action: e.action,
        targetType: "operator",
        targetId: e.targetId ?? null,
        operatorId: e.operatorId ?? null,
        before: (e.before ?? undefined) as any,
        after: (e.after ?? undefined) as any,
        meta: (e.meta ?? undefined) as any,
      },
    });
  } catch (err) {
    console.warn(`  ⚠ audit event write failed (best-effort, ignored): ${String(err)}`);
  }
}

/** Create or update an operator (upsert by code). Returns the row, whether it was
 *  created, and the launchSecret ONLY when freshly generated (create or rotate). */
export async function provisionOperator(
  prisma: Pick<PrismaClient, "operator" | "auditEvent">,
  input: ProvisionInput,
): Promise<{ operator: any; created: boolean; launchSecret?: string; reportingApiKey?: string; writeApiKey?: string; unknownCurrencies: string[] }> {
  // Canonicalise currency codes to UPPERCASE (ISO-4217) on write so the launch-time
  // allow-list check and the per-currency limit lookup (both case-insensitive /
  // uppercased) always match what the operator stored.
  const betLimits =
    input.betLimits !== undefined ? upperKeys(validateBetLimits(input.betLimits)) : undefined;
  const rgConfig =
    input.rgConfig !== undefined ? upperKeysRgLimits(validateRgConfig(input.rgConfig)) : undefined;
  if (typeof input.callbackUrl === "string") validateCallbackUrl(input.callbackUrl);
  const currencies = input.currencies?.map((c) => c.toUpperCase());

  // Phase 3.6: flag currencies with no canonical precision entry. Default = warn (a
  // genuinely-new token can be onboarded before it's seeded; currencyMeta falls back to
  // 2 dp). --strict-currencies turns it into a hard error (checked BEFORE any write).
  const unknownCurrencies = (currencies ?? []).filter((c) => !isKnownCurrency(c));
  if (input.strictCurrencies && unknownCurrencies.length > 0) {
    throw new Error(
      `unknown currency code(s) not in the canonical table (src/common/currency.ts): ${unknownCurrencies.join(", ")}`,
    );
  }

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

  // Significant-event audit log (F-058). Record WHAT config changed — but NEVER a secret
  // value: a rotated launchSecret is logged only as the flag `launchSecretRotated`, and
  // walletApiKey is reduced to whether one is set. (The reporting-key rotation is its own
  // event below.) on CREATE = operator.provision; on UPDATE = operator.config_update.
  const sanitizedPatch: Record<string, unknown> = { ...patch };
  if ("launchSecret" in sanitizedPatch) {
    delete sanitizedPatch.launchSecret;
    sanitizedPatch.launchSecretRotated = true;
  }
  if ("walletApiKey" in sanitizedPatch) sanitizedPatch.walletApiKey = input.walletApiKey ? "(set)" : "(cleared)";
  await recordAudit(prisma, {
    action: created ? "operator.provision" : "operator.config_update",
    targetId: operator.id,
    operatorId: operator.id,
    after: created
      ? { code: operator.code, name: operator.name, enabled: operator.enabled, demoEnabled: operator.demoEnabled, currencies: operator.currencies, walletApiSet: !!operator.walletApiKey }
      : sanitizedPatch,
    meta: { code: operator.code, unknownCurrencies },
  });

  // Optional: mint/rotate the inbound READ (reporting) and/or WRITE api keys. Each token embeds
  // the operator id (known only after the upsert), so we store its hash in a follow-up update and
  // return the plaintext token ONCE. Rotating invalidates any prior key of that scope. The two
  // scopes are INDEPENDENT — an operator can have a read key but no write key (then every write
  // route fails closed), or rotate one without touching the other. F-058: record the rotation
  // WITHOUT the token or the hash — only the self-describing algo prefix ("sha256:" /
  // "hmac-sha256:") so an auditor sees that (and how) it happened.
  let reportingApiKey: string | undefined;
  if (input.rotateReportingKey) {
    const { token, hash } = generateReportingKey(operator.id);
    await prisma.operator.update({ where: { id: operator.id }, data: { reportingApiKeyHash: hash } });
    reportingApiKey = token;
    const hashPrefix = hash.includes(":") ? `${hash.slice(0, hash.indexOf(":"))}:` : "(unknown)";
    await recordAudit(prisma, {
      action: "reporting_key.rotate",
      targetId: operator.id,
      operatorId: operator.id,
      meta: { code: operator.code, hashPrefix },
    });
  }

  let writeApiKey: string | undefined;
  if (input.rotateWriteKey) {
    const { token, hash } = generateWriteKey(operator.id);
    await prisma.operator.update({ where: { id: operator.id }, data: { writeApiKeyHash: hash } });
    writeApiKey = token;
    const hashPrefix = hash.includes(":") ? `${hash.slice(0, hash.indexOf(":"))}:` : "(unknown)";
    await recordAudit(prisma, {
      action: "write_key.rotate",
      targetId: operator.id,
      operatorId: operator.id,
      meta: { code: operator.code, hashPrefix },
    });
  }

  return {
    operator,
    created,
    launchSecret: created || input.rotateSecret ? operator.launchSecret : undefined,
    reportingApiKey,
    writeApiKey,
    unknownCurrencies,
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
        "  [--ip-whitelist a,b] [--callback-url ..] [--disabled] [--demo-enabled|--demo-disabled] [--rotate-secret] [--rotate-reporting-key] [--rotate-write-key] [--strict-currencies]",
    );
    process.exit(1);
  }

  let betLimits: unknown;
  const bl = str(args["bet-limits"]);
  if (bl) {
    const raw = bl.startsWith("@") ? readFileSync(bl.slice(1), "utf8") : bl;
    betLimits = JSON.parse(raw);
  }

  let rgConfig: unknown;
  const rgc = str(args["rg-config"]);
  if (rgc) {
    const raw = rgc.startsWith("@") ? readFileSync(rgc.slice(1), "utf8") : rgc;
    rgConfig = JSON.parse(raw);
  }

  const prisma = new PrismaClient();
  try {
    const { operator, created, launchSecret, reportingApiKey, writeApiKey, unknownCurrencies } = await provisionOperator(prisma, {
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
      rotateReportingKey: args["rotate-reporting-key"] === true,
      rotateWriteKey: args["rotate-write-key"] === true,
      strictCurrencies: args["strict-currencies"] === true,
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
    if (unknownCurrencies.length > 0) {
      console.warn(
        `  ⚠ currencies with NO canonical precision entry (client will assume 2 dp): ${unknownCurrencies.join(", ")}\n` +
          `    add them to src/common/currency.ts, or pass --strict-currencies to reject.`,
      );
    }
    if (launchSecret) {
      console.log(`\n  launchSecret (${created ? "new" : "ROTATED — outstanding launch tokens are now invalid"}):`);
      console.log(`    ${launchSecret}`);
      console.log(`  ^ store securely (1Password) + share with the operator; it signs their launch tokens. Shown once.`);
    }
    const keyMode = () => (process.env.REPORTING_KEY_PEPPER ? "HMAC-SHA256 (peppered)" : "SHA-256 (no pepper)");
    if (reportingApiKey) {
      console.log(`\n  READ (reporting) API key (ROTATED — any prior reporting key is now invalid):`);
      console.log(`    ${reportingApiKey}`);
      console.log(`  ^ the operator sends this as 'Authorization: Bearer <key>' to the READ routes`);
      console.log(`    (/api/operator/reports/*, /api/operator/audit-events). READ-ONLY — it CANNOT void/revoke.`);
      console.log(`    Shown once; store in 1Password + share with the operator.`);
      console.log(`    hash mode: ${keyMode()}. If peppered, the APP must run with the SAME REPORTING_KEY_PEPPER`);
      console.log(`    or the stored hash won't verify (DEPLOY.md §12).`);
    }
    if (writeApiKey) {
      console.log(`\n  WRITE API key (ROTATED — any prior write key is now invalid):`);
      console.log(`    ${writeApiKey}`);
      console.log(`  ^ a SEPARATE, higher-privilege key for the WRITE routes (void / session-revoke / erasure):`);
      console.log(`    'Authorization: Bearer <key>' to e.g. POST /api/operator/bets/:betId/void. Shown once;`);
      console.log(`    store in 1Password + share with the operator. Keep it MORE restricted than the read key.`);
      console.log(`    hash mode: ${keyMode()} (same REPORTING_KEY_PEPPER applies). Without a write key provisioned,`);
      console.log(`    every write route is DENIED (fail-closed).`);
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
