// Build/version traceability (audit F-059). One place that resolves the running
// build's identity so /version and the vaultrun_build_info metric never drift:
//   - version: read from package.json (the deployed artifact's declared version);
//   - commit / buildTime: baked into the image as ENV by the Dockerfile (--build-arg
//     GIT_SHA / BUILD_TIME), defaulting to "unknown" when built without them (so
//     behaviour is identical to before this fix on a plain local `bun run`).
import pkg from "../../package.json";

export const BUILD_SERVICE = "vault-runner-api";
export const BUILD_VERSION: string = pkg.version || "unknown";

/** An env var that is unset OR empty ("") reads as "unknown" — so a build-arg that was
 *  declared but passed empty still degrades gracefully (not a blank commit label). */
const envOrUnknown = (v: string | undefined): string => (v && v.trim() ? v : "unknown");

/** The running build's commit (read here so the metric + /version never drift). */
export const BUILD_COMMIT = (): string => envOrUnknown(process.env.GIT_SHA);

/** The running build's identity, for GET /version. Env is read at call time so a
 *  test can set GIT_SHA/BUILD_TIME without a rebuild. */
export function buildInfo(): {
  service: string;
  version: string;
  commit: string;
  buildTime: string;
} {
  return {
    service: BUILD_SERVICE,
    version: BUILD_VERSION,
    commit: BUILD_COMMIT(),
    buildTime: envOrUnknown(process.env.BUILD_TIME),
  };
}
