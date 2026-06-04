import { z } from "zod";

/**
 * Per-currency, per-bet limits for an operator (Phase 3). Stored on the untyped
 * `Operator.betLimits` JSON column as:
 *
 *   { "EUR": { "minBet": 10, "maxBet": 10000, "maxWinPerBet": 1000000 }, "USDT": { … } }
 *
 * All amounts are INTEGER MINOR units (cents / satoshi …) — JSON has no bigint,
 * so they're stored as non-negative integers and converted to BigInt at use.
 * These are the per-BET knobs RiskService already owns (min/max stake + the
 * single-bet win cap). `maxMultiplier` stays a global engine constant and the
 * round-exposure cap stays global/house-level (cross-currency summing needs FX —
 * deferred), so they are deliberately NOT here.
 */
export const PerCurrencyLimitSchema = z
  .object({
    minBet: z.number().int().nonnegative(),
    maxBet: z.number().int().positive(),
    maxWinPerBet: z.number().int().positive(),
  })
  .refine((l) => l.maxBet >= l.minBet, { message: "maxBet must be >= minBet" })
  .refine((l) => l.maxWinPerBet >= l.maxBet, { message: "maxWinPerBet must be >= maxBet" });

/** Operator.betLimits shape: a map of currency code → per-bet limits. */
export const BetLimitsSchema = z.record(z.string().min(1), PerCurrencyLimitSchema);

export type BetLimitsConfig = z.infer<typeof BetLimitsSchema>;

/** Effective per-bet limits in BigInt minor units — what RiskService consumes. */
export interface EffectiveBetLimits {
  minBet: bigint;
  maxBet: bigint;
  maxWinPerBet: bigint;
}

/** Strict validate untyped input as a betLimits config; THROWS (Zod) on invalid.
 *  Used at WRITE time (provisioning) so bad config never enters the DB. */
export function validateBetLimits(json: unknown): BetLimitsConfig {
  return BetLimitsSchema.parse(json);
}

/** Defensive parse — returns the config, or null if absent/garbage, so a
 *  hand-edited bad row falls back to global defaults instead of crashing a bet. */
export function parseBetLimits(json: unknown): BetLimitsConfig | null {
  if (json == null) return null;
  const r = BetLimitsSchema.safeParse(json);
  return r.success ? r.data : null;
}

/**
 * Resolve the effective per-bet limits for a currency from an operator's
 * betLimits JSON. Returns null when there is no (valid) config for that currency
 * → the caller then uses the global env defaults (internal/guest behaviour).
 */
export function effectiveLimitsFor(json: unknown, currency: string): EffectiveBetLimits | null {
  const cfg = parseBetLimits(json);
  if (!cfg) return null;
  const want = (currency ?? "").toUpperCase();
  // Case-INSENSITIVE own-key match. Config keys are canonically uppercase, but a
  // legacy / hand-edited lowercase key MUST still resolve — otherwise the operator's
  // per-currency limit silently fails OPEN to the looser global cap (money-path +
  // security audit). Object.keys() is own-enumerable only, so a currency like
  // "toString"/"__proto__" can never hit an inherited Object.prototype member (which
  // would then throw in BigInt()).
  for (const k of Object.keys(cfg)) {
    if (k.toUpperCase() === want) {
      const l = cfg[k];
      return {
        minBet: BigInt(l.minBet),
        maxBet: BigInt(l.maxBet),
        maxWinPerBet: BigInt(l.maxWinPerBet),
      };
    }
  }
  return null;
}

/** JSON/JWT-safe form of EffectiveBetLimits — BigInt minor units as decimal strings
 *  (JSON/JWT can't carry BigInt). Used to put the session's resolved limits on the
 *  play token + (the maxWinPerBet) on the bet row. */
export interface SerializedBetLimits {
  minBet: string;
  maxBet: string;
  maxWinPerBet: string;
}

export function serializeBetLimits(l: EffectiveBetLimits): SerializedBetLimits {
  return {
    minBet: l.minBet.toString(),
    maxBet: l.maxBet.toString(),
    maxWinPerBet: l.maxWinPerBet.toString(),
  };
}

/** Parse the serialized form (a JWT claim / stored JSON) back to BigInt. Defensive:
 *  null on anything malformed or that fails the limit invariants, so a tampered or
 *  garbage claim falls back to the global defaults instead of mis-limiting a bet. */
export function deserializeBetLimits(json: unknown): EffectiveBetLimits | null {
  if (json == null || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  try {
    const minBet = BigInt(o.minBet as string | number);
    const maxBet = BigInt(o.maxBet as string | number);
    const maxWinPerBet = BigInt(o.maxWinPerBet as string | number);
    if (minBet < 0n || maxBet < minBet || maxWinPerBet < maxBet) return null;
    return { minBet, maxBet, maxWinPerBet };
  } catch {
    return null;
  }
}
