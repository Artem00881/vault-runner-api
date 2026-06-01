import * as Sentry from "@sentry/bun";

let enabled = false;

/**
 * Initialize Sentry error tracking — ONLY when `SENTRY_DSN` is set, so the app
 * runs unchanged without it (a no-op). Call once, before the Nest app is built.
 *
 * Uses `@sentry/bun` (the Bun-native SDK), which also installs process-level
 * handlers for uncaughtException / unhandledRejection. Errors only (no perf
 * tracing) to keep it light. Never lets observability break boot.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? "production",
      release: process.env.SENTRY_RELEASE,
      tracesSampleRate: 0,
      sampleRate: 1.0,
    });
    enabled = true;
    // eslint-disable-next-line no-console
    console.log("[sentry] error tracking enabled");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[sentry] init failed (continuing without it): ${(e as Error)?.message}`);
  }
}

export function isSentryEnabled(): boolean {
  return enabled;
}

/** Report an exception to Sentry if enabled; no-op otherwise. Never throws. */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    /* swallow — observability must not affect request handling */
  }
}
