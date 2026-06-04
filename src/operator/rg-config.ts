import { z } from "zod";

/**
 * Per-operator responsible-gambling (RG) config (Phase 3). Stored on the untyped
 * `Operator.rgConfig` JSON column. In-session controls only — the operator owns
 * account-level RG (self-exclusion, daily/deposit limits, KYC) and simply doesn't
 * mint a launch token for an excluded / over-limit player; we enforce the
 * SESSION-scoped controls the operator configures here:
 *
 *   {
 *     "realityCheckIntervalSec": 3600,  // periodic time/net reminder (currency-agnostic)
 *     "maxSessionSec": 86400,           // max session duration (currency-agnostic)
 *     "enforceRealityCheck": true,      // hard-pause new bets until ack (default TRUE)
 *     "limits": {                       // per-currency money caps (minor units)
 *       "EUR": { "maxSessionLoss": 50000, "maxSessionWager": 200000 }
 *     }
 *   }
 *
 * Mirrors `bet-limits.ts` exactly (validate at write, defensive parse at read,
 * serialize/deserialize for the signed play token). RG applies ONLY to real-money
 * sessions — demo/fun-mode and guests skip RG (play money can't cause harm); the
 * skip is enforced at resolution (no `rg` claim is minted for a demo launch) AND
 * again at the bet path (defense in depth). Money knobs are integer MINOR units
 * (JSON has no bigint → stored as integers, converted to BigInt at use); time knobs
 * are seconds. Currency keys are canonical ISO-4217 UPPERCASE (provisioning
 * canonicalises; resolution is case-insensitive).
 *
 * NET-LOSS / accounting note: a session's net loss = wagered − won, derived from
 * Bet rows; an UNSETTLED (active) stake is counted as at-risk loss (full stake,
 * payout 0) so a player can't dodge the loss cap by leaving bets open — the
 * protective, cert-defensible direction (see BetsService.sessionAccounting).
 */

// Sane bounds on the time knobs. Floored so a misconfig can't create a reality-check
// storm / 1s session; CAPPED so a too-large value can't silently DISABLE the control
// (fail-open by misconfig — a cert lab probes exactly this). Mirrored in deserializeRg.
const MIN_TIME_SEC = 60;
export const MAX_REALITY_CHECK_INTERVAL_SEC = 86_400; // 24h — a reality check at least daily
export const MAX_SESSION_SEC = 2_592_000; // 30 days — absolute session-length ceiling

const PerCurrencyRgLimitSchema = z.object({
  maxSessionLoss: z.number().int().positive().optional(),
  maxSessionWager: z.number().int().positive().optional(),
});

export const RgConfigSchema = z
  .object({
    realityCheckIntervalSec: z.number().int().min(MIN_TIME_SEC).max(MAX_REALITY_CHECK_INTERVAL_SEC).optional(),
    maxSessionSec: z.number().int().min(MIN_TIME_SEC).max(MAX_SESSION_SEC).optional(),
    enforceRealityCheck: z.boolean().optional(), // semantic default TRUE, applied at resolution
    limits: z.record(z.string().min(1), PerCurrencyRgLimitSchema).optional(),
  })
  .strict(); // reject unknown keys → a typo'd config fails loudly at write time

export type RgConfig = z.infer<typeof RgConfigSchema>;

/** Effective per-session RG resolved for one currency — what the gateway/bet path use.
 *  Money in BigInt minor units; time in seconds. */
export interface EffectiveRg {
  realityCheckIntervalSec?: number;
  maxSessionSec?: number;
  enforceRealityCheck: boolean;
  maxSessionLoss?: bigint;
  maxSessionWager?: bigint;
}

/** Strict validate untyped input as an rgConfig; THROWS (Zod) on invalid. Used at
 *  WRITE time (provisioning) so bad config never enters the DB. */
export function validateRgConfig(json: unknown): RgConfig {
  return RgConfigSchema.parse(json);
}

/** Defensive parse — returns the config, or null if absent/garbage, so a hand-edited
 *  bad row falls back to NO RG instead of crashing a launch. */
export function parseRgConfig(json: unknown): RgConfig | null {
  if (json == null) return null;
  const r = RgConfigSchema.safeParse(json);
  return r.success ? r.data : null;
}

/**
 * Resolve the effective RG for a currency from an operator's rgConfig JSON. The
 * time knobs (reality-check interval, max session) are currency-AGNOSTIC and apply
 * even when a currency has no money-limit entry; the loss/wager caps are looked up
 * per currency (case-INSENSITIVE own-key match — config keys are canonically
 * uppercase, but a legacy lowercase key must still resolve, and `Object.keys` is
 * own-enumerable only so a currency like "__proto__"/"toString" can never hit an
 * inherited member). Returns null when there is no config OR no active control at
 * all (so a no-op/empty config mints no token claim).
 */
export function effectiveRgFor(json: unknown, currency: string): EffectiveRg | null {
  const cfg = parseRgConfig(json);
  if (!cfg) return null;

  const want = (currency ?? "").toUpperCase();
  let loss: bigint | undefined;
  let wager: bigint | undefined;
  if (cfg.limits) {
    for (const k of Object.keys(cfg.limits)) {
      if (k.toUpperCase() === want) {
        const l = cfg.limits[k];
        if (l.maxSessionLoss !== undefined) loss = BigInt(l.maxSessionLoss);
        if (l.maxSessionWager !== undefined) wager = BigInt(l.maxSessionWager);
        break;
      }
    }
  }

  const eff: EffectiveRg = { enforceRealityCheck: cfg.enforceRealityCheck ?? true };
  if (cfg.realityCheckIntervalSec !== undefined) eff.realityCheckIntervalSec = cfg.realityCheckIntervalSec;
  if (cfg.maxSessionSec !== undefined) eff.maxSessionSec = cfg.maxSessionSec;
  if (loss !== undefined) eff.maxSessionLoss = loss;
  if (wager !== undefined) eff.maxSessionWager = wager;

  // No active control → no RG (don't mint a useless claim).
  if (
    eff.realityCheckIntervalSec === undefined &&
    eff.maxSessionSec === undefined &&
    eff.maxSessionLoss === undefined &&
    eff.maxSessionWager === undefined
  ) {
    return null;
  }
  return eff;
}

/** JSON/JWT-safe form of EffectiveRg — BigInt money as decimal strings (JWT can't
 *  carry BigInt); time/boolean passthrough. Rides the signed play token. */
export interface SerializedRg {
  realityCheckIntervalSec?: number;
  maxSessionSec?: number;
  enforceRealityCheck: boolean;
  maxSessionLoss?: string;
  maxSessionWager?: string;
}

export function serializeRg(e: EffectiveRg): SerializedRg {
  const s: SerializedRg = { enforceRealityCheck: e.enforceRealityCheck };
  if (e.realityCheckIntervalSec !== undefined) s.realityCheckIntervalSec = e.realityCheckIntervalSec;
  if (e.maxSessionSec !== undefined) s.maxSessionSec = e.maxSessionSec;
  if (e.maxSessionLoss !== undefined) s.maxSessionLoss = e.maxSessionLoss.toString();
  if (e.maxSessionWager !== undefined) s.maxSessionWager = e.maxSessionWager.toString();
  return s;
}

/** Parse the serialized form (a JWT claim) back to BigInt/EffectiveRg. Defensive:
 *  null on anything malformed or with no active control, so a garbage claim falls
 *  back to NO RG. (The claim is inside OUR signed play token, so a TAMPERED claim
 *  fails signature verification at the gateway BEFORE this runs — this null-safety
 *  is defense-in-depth against our own mis-serialization, not an attacker surface.) */
export function deserializeRg(json: unknown): EffectiveRg | null {
  if (json == null || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  try {
    const eff: EffectiveRg = { enforceRealityCheck: o.enforceRealityCheck !== false }; // absent/true → true
    if (o.realityCheckIntervalSec !== undefined) {
      const n = Number(o.realityCheckIntervalSec);
      if (!Number.isInteger(n) || n <= 0 || n > MAX_REALITY_CHECK_INTERVAL_SEC) return null;
      eff.realityCheckIntervalSec = n;
    }
    if (o.maxSessionSec !== undefined) {
      const n = Number(o.maxSessionSec);
      if (!Number.isInteger(n) || n <= 0 || n > MAX_SESSION_SEC) return null;
      eff.maxSessionSec = n;
    }
    if (o.maxSessionLoss !== undefined) {
      const b = BigInt(o.maxSessionLoss as string | number);
      if (b <= 0n) return null;
      eff.maxSessionLoss = b;
    }
    if (o.maxSessionWager !== undefined) {
      const b = BigInt(o.maxSessionWager as string | number);
      if (b <= 0n) return null;
      eff.maxSessionWager = b;
    }
    if (
      eff.realityCheckIntervalSec === undefined &&
      eff.maxSessionSec === undefined &&
      eff.maxSessionLoss === undefined &&
      eff.maxSessionWager === undefined
    ) {
      return null;
    }
    return eff;
  } catch {
    return null;
  }
}
