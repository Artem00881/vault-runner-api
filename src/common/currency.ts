import { z } from "zod";

/**
 * Canonical per-currency PRECISION (decimals) metadata (Phase 3.6, multi-currency).
 *
 * Money is stored/moved as integer minor units (BigInt) everywhere; the wire carries
 * raw minor units + an uppercase currency code, but the client needs the number of
 * decimal places to render a human value (EUR 2 → 1234 = €12.34; USDT 6; BTC 8; ETH
 * 18; JPY 0). This is the single source of truth for that — the values were doc-only
 * before (game-math-spec.md §12).
 *
 * Decimals are intrinsic to the CURRENCY (ISO-4217 minor unit / token standard), NOT
 * to an operator — two operators offering EUR both mean cents — so this is ONE global
 * table, not per-operator config. It is DISPLAY metadata only: no money math reads it,
 * so a wrong/missing entry can never corrupt the ledger (minor units stay exact),
 * only mis-scale a client's display.
 *
 * EXTENSION POINT: to support a new currency/token, add a row below (one reviewed
 * line). An unknown currency does NOT break a live launch/report — currencyMeta()
 * falls back to { decimals: 2, known: false } so the path stays up; `known:false`
 * lets the client/logs flag "precision unverified". A per-operator override is
 * deliberately NOT supported (it would contradict "decimals are intrinsic").
 */
/** Canonical currency-code shape (uppercase alnum, 1–16). Shared with reporting-query. */
export const CURRENCY_CODE_RE = /^[A-Z0-9]{1,16}$/;

export const CurrencyMetaSchema = z
  .object({
    code: z.string().regex(CURRENCY_CODE_RE),
    decimals: z.number().int().min(0).max(18),
    name: z.string().optional(),
  })
  .strict();

export type CurrencyMeta = z.infer<typeof CurrencyMetaSchema>;
export interface CurrencyMetaResolved extends CurrencyMeta {
  known: boolean; // false → not in the table; decimals is the 2-dp fallback guess
}

const DEFAULT_DECIMALS = 2;

// The seed set (game-math-spec.md §12 + common fiat). JPY=0 / ETH=18 are the
// non-2-decimal canaries that prove this table is real, not "always 2".
const SEED: CurrencyMeta[] = [
  { code: "DEMO", decimals: 2, name: "Demo Credits" },
  { code: "EUR", decimals: 2, name: "Euro" },
  { code: "USD", decimals: 2, name: "US Dollar" },
  { code: "GBP", decimals: 2, name: "Pound Sterling" },
  { code: "CHF", decimals: 2, name: "Swiss Franc" },
  { code: "CAD", decimals: 2, name: "Canadian Dollar" },
  { code: "AUD", decimals: 2, name: "Australian Dollar" },
  { code: "BRL", decimals: 2, name: "Brazilian Real" },
  { code: "INR", decimals: 2, name: "Indian Rupee" },
  { code: "JPY", decimals: 0, name: "Japanese Yen" },
  { code: "USDT", decimals: 6, name: "Tether" },
  { code: "USDC", decimals: 6, name: "USD Coin" },
  { code: "BTC", decimals: 8, name: "Bitcoin" },
  { code: "ETH", decimals: 18, name: "Ether" },
];

// Validate the seed at module load (fail-fast on a typo'd entry) + dedup guard.
export const CURRENCIES: readonly CurrencyMeta[] = SEED.map((c) => CurrencyMetaSchema.parse(c));
const BY_CODE: ReadonlyMap<string, CurrencyMeta> = new Map(CURRENCIES.map((c) => [c.code, c]));
if (BY_CODE.size !== CURRENCIES.length) throw new Error("currency table has duplicate codes");

/**
 * Resolve a currency's metadata. Case-insensitive; own-key-safe (a Map has no
 * Object.prototype, so a "currency" of "__proto__"/"toString"/"constructor" can never
 * hit an inherited member — prototype-pollution defense, same posture as
 * effectiveLimitsFor). Unknown/empty/garbage → { decimals: 2, known: false } (never
 * throws), so a live launch/report never breaks on an unseeded code.
 */
export function currencyMeta(code: string | null | undefined): CurrencyMetaResolved {
  // String(...) (not `?? ""`) so a non-string (number/object/…) can't throw on
  // .toUpperCase() — honours the "never throws" contract. A non-string just misses
  // the Map → known:false. (Same guard posture as normalizeLocale.)
  const upper = String(code ?? "").toUpperCase();
  const hit = BY_CODE.get(upper);
  if (hit) return { ...hit, known: true };
  return { code: upper, decimals: DEFAULT_DECIMALS, known: false };
}

/** True when the code is in the canonical table (for the provisioning guard). */
export function isKnownCurrency(code: string | null | undefined): boolean {
  return BY_CODE.has((code ?? "").toUpperCase());
}

/** The full table (sorted by code) for the public /api/currencies discovery endpoint.
 *  Returns deep COPIES of each row so a caller can't mutate the canonical table. */
export function listCurrencies(): CurrencyMeta[] {
  return CURRENCIES.map((c) => ({ ...c })).sort((a, b) => a.code.localeCompare(b.code));
}
