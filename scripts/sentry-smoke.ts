/**
 * Boot smoke for the Sentry integration on Bun. Confirms initSentry() +
 * captureException() don't crash, in both modes:
 *   bun scripts/sentry-smoke.ts                          # no DSN  → disabled (no-op)
 *   SENTRY_DSN=https://x@o0.ingest.sentry.io/0 bun scripts/sentry-smoke.ts  # → enabled
 */
import { initSentry, isSentryEnabled, captureException } from "../src/observability/sentry";

initSentry();
captureException(new Error("sentry-smoke test error"), { smoke: true });
console.log(`sentry-smoke: SENTRY_DSN ${process.env.SENTRY_DSN ? "set" : "unset"} → enabled=${isSentryEnabled()} (no crash)`);
process.exit(0);
