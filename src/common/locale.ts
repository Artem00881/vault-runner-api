/**
 * Lenient BCP-47-ish locale normalization (Phase 3.6). `locale` is an
 * operator-controlled, COSMETIC pass-through (launch token → GameSession.locale →
 * play token + launch response); the operator owns actual translation. We only
 * normalize casing and reject garbage so the DB/token never store `"'; DROP"` or a
 * 5 KB blob. Never throws — a bad locale must not 401 a launch; it defaults to "en".
 *
 * Accepts language[-subtag[-subtag]] (e.g. en, en-US, pt-BR, es-419, zh-Hans-CN).
 * Normalizes: language → lowercase; ANY 2-letter subtag after the language →
 * UPPERCASE (region heuristic — script/variant casing is NOT canonicalized, since
 * locale is only a display hint the operator owns). Anything else → "en".
 */
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

export function normalizeLocale(raw: unknown): string {
  if (typeof raw !== "string") return "en";
  const s = raw.trim();
  if (!LOCALE_RE.test(s)) return "en";
  const [lang, ...subs] = s.split("-");
  const tail = subs.map((sub) => (/^[A-Za-z]{2}$/.test(sub) ? sub.toUpperCase() : sub));
  return [lang.toLowerCase(), ...tail].join("-");
}
