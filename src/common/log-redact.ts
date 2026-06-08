/**
 * Log-hygiene helpers (F-069). A pseudonymous id (e.g. the internal `userId` UUID) is
 * still personal data under GDPR, so it must not be written verbatim into application
 * logs. `shortId` keeps just enough of the id to CORRELATE log lines for one actor
 * within a short retention window, while dropping the full identifier.
 *
 * Format: the first 8 chars + an ellipsis (`a1b2c3d4…`). A UUID's first 8 hex chars are
 * ample to distinguish actors in a single incident, but on their own are not a usable
 * lookup key. An empty/absent id renders as `unknown` (never a bare `undefined…`).
 */
export function shortId(id: string | null | undefined): string {
  if (!id) return "unknown";
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}
