import { test, expect } from "bun:test";
import "reflect-metadata";
import { THROTTLER_LIMIT, THROTTLER_TTL } from "@nestjs/throttler/dist/throttler.constants";
import { AuthController } from "../src/auth/auth.controller";

/**
 * Regression for F-011: the unauthenticated guest-mint route (POST /api/auth/guest) must
 * carry a dedicated, TIGHT per-IP throttle (NOT just the global 120/min IP limit), so a
 * rotating-IP client can't fabricate large numbers of funded play-money accounts.
 *
 * We assert the @Throttle metadata the IpThrottlerGuard reads is present on the guest handler
 * and is much lower than the global limit. (A full HTTP rate-limit integration test would need
 * a live server + storage; the metadata assertion is the focused proof the route is governed
 * by its own decorator, matching the finding's "optionally a throttle-applied unit assertion".)
 */

// @Throttle({ default: { ttl, limit } }) sets metadata on the method (descriptor.value) under
// `${THROTTLER_LIMIT}default` / `${THROTTLER_TTL}default` (see @nestjs/throttler decorator).
const guest = AuthController.prototype.guest as unknown as object;

test("F-011: /api/auth/guest carries a dedicated @Throttle (tighter than the global IP limit)", () => {
  const limit = Reflect.getMetadata(THROTTLER_LIMIT + "default", guest);
  const ttl = Reflect.getMetadata(THROTTLER_TTL + "default", guest);

  expect(limit).toBeDefined();
  expect(ttl).toBeDefined();
  expect(typeof limit).toBe("number");
  expect(typeof ttl).toBe("number");

  // The route limit must be a few per window — well below the global 120/min IP throttle.
  expect(limit as number).toBeGreaterThanOrEqual(1);
  expect(limit as number).toBeLessThan(120);
  expect(ttl as number).toBeGreaterThan(0);
});
