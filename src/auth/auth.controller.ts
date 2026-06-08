import { Controller, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";

// F-011: guest-mint is a resource-amplification vector — every unauthenticated call creates
// a User + Profile + funded play-money Wallet. The global IP throttle (120/min) lets one IP
// fabricate thousands of funded accounts before tripping. Apply a much tighter PER-IP limit
// to JUST this account-minting route (the IpThrottlerGuard keys by the real client IP, so a
// legit first-time guest is unaffected — a person launches the demo once, not 6×/min). Env-
// tunable; defaults to 5/min, clamped to >= 1. (Prod uses operator launch tokens, not guest —
// this primarily hardens the demo/sandbox.)
// Finite-guarded so a malformed (non-numeric) env can't yield NaN — the throttler blocks on
// `hits > limit`, and `> NaN` is always false, which would SILENTLY DISABLE the throttle
// (fail-open). On bad input fall back to the safe default (mirrors the SESSION_TOKEN_TTL_SEC /
// DEMO_STARTING_BALANCE clamps elsewhere).
const numEnv = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt;
};
const GUEST_THROTTLE_TTL_MS = numEnv(process.env.GUEST_THROTTLE_TTL_MS, 60_000);
const GUEST_THROTTLE_LIMIT = numEnv(process.env.GUEST_THROTTLE_LIMIT, 5);

@Controller("api/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Create a guest session and return a JWT + funded play-money wallet. */
  @Throttle({ default: { ttl: GUEST_THROTTLE_TTL_MS, limit: GUEST_THROTTLE_LIMIT } })
  @Post("guest")
  guest() {
    return this.auth.createGuest();
  }
}
