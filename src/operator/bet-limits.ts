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
  // OWN-key lookup only: a currency like "toString"/"constructor"/"__proto__" must
  // resolve to null (→ global defaults), NEVER an inherited Object.prototype member
  // (which would then throw in BigInt()). `currency` is operator-controlled (the
  // launch-token claim), so this guard is load-bearing once wired into the bet path.
  const l = cfg && Object.prototype.hasOwnProperty.call(cfg, currency) ? cfg[currency] : undefined;
  if (!l) return null;
  return {
    minBet: BigInt(l.minBet),
    maxBet: BigInt(l.maxBet),
    maxWinPerBet: BigInt(l.maxWinPerBet),
  };
}
