import { Injectable, Inject, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { normalizeLocale } from "../common/locale";

/**
 * Signed launch-token ("ticket") protocol for opening the game from an operator
 * lobby. Industry-standard approach:
 *
 *  - JWT signed with the OPERATOR's own secret (per-operator HMAC-SHA256), so a
 *    ticket can only be forged by someone holding that operator's secret.
 *  - Short `exp` (≈2 min) — a ticket can't be hoarded and replayed later.
 *  - Unique `jti` consumed ONCE (recorded on the GameSession) — an intercepted
 *    ticket can't be used twice.
 *
 * `issue` is normally done on the OPERATOR side; we implement it for the demo /
 * sandbox / tests. `verify` is what we run when the player opens the game.
 */
export interface LaunchClaims {
  operatorId: string; // our Operator.id
  playerId: string; // operator-side player id
  currency: string;
  locale?: string;
  /** play-money "fun mode" — settle on the internal ledger, never the operator wallet */
  demo?: boolean;
  /** optional per-launch limit/round context */
  ctx?: Record<string, unknown>;
}

export interface VerifiedLaunch extends LaunchClaims {
  jti: string;
  locale: string;
  demo: boolean;
}

const TTL_SECONDS = 120;

// #1 — sane upper bound on the operator-supplied `playerId`. This is the one operator-supplied
// free-string id we accept INBOUND that flows into a persisted, UNIQUE key (the User.username tag
// `op:{operatorId}:{playerId}:{currency}[:demo]`) and into the per-operator B-tree index lookups
// (anonymize / session-revoke prefix scans). It is operator-SIGNED (only the operator can mint a
// launch token), so this is defense-in-depth — not an auth boundary — but an unbounded id would
// bloat the unique username + every index entry. 200 matches the outbound transactionId cap.
const MAX_PLAYER_ID_LEN = 200;

@Injectable()
export class LaunchTokenService {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** Issue a launch token signed with the operator's secret (demo/sandbox). */
  async issue(claims: LaunchClaims): Promise<string> {
    const op = await this.prisma.operator.findUniqueOrThrow({ where: { id: claims.operatorId } });
    if (!op.enabled) throw new UnauthorizedException("operator_disabled");
    return this.jwt.signAsync(
      {
        operatorId: claims.operatorId,
        playerId: claims.playerId,
        currency: claims.currency,
        locale: normalizeLocale(claims.locale),
        demo: claims.demo ?? false,
        ctx: claims.ctx ?? {},
      },
      { secret: op.launchSecret, expiresIn: TTL_SECONDS, jwtid: randomUUID() },
    );
  }

  /**
   * Verify a launch token: decode (without trust) to find the operator, then
   * verify the signature with THAT operator's secret, check expiry, and ensure
   * the jti hasn't been consumed. Returns the verified claims; consuming the jti
   * (one-time use) happens when the session is created.
   */
  async verify(token: string): Promise<VerifiedLaunch> {
    // 1) decode without verifying to learn which operator's secret to use.
    const unsafe = this.jwt.decode(token) as Record<string, any> | null;
    const operatorId = unsafe?.operatorId;
    if (!operatorId) throw new UnauthorizedException("invalid_launch_token");

    const op = await this.prisma.operator.findUnique({ where: { id: operatorId } });
    if (!op || !op.enabled) throw new UnauthorizedException("unknown_operator");

    // 2) verify signature + expiry with the operator's own secret.
    let payload: Record<string, any>;
    try {
      payload = await this.jwt.verifyAsync(token, { secret: op.launchSecret });
    } catch {
      throw new UnauthorizedException("invalid_launch_token");
    }

    // Phase 3: enforce the operator's allowed-currency list. A launch token whose
    // currency isn't configured for this operator is rejected; an empty list is
    // fail-closed (provision the operator WITH its currencies). The jti is NOT yet
    // consumed here (no GameSession is written), so the operator can re-issue a
    // corrected token. Case-INSENSITIVE (ISO-4217 canonical uppercase) so a casing
    // mismatch doesn't silently 401 — openFromToken stores the uppercased currency.
    const ccy = (payload.currency ?? "").toUpperCase();
    if (!op.currencies.some((c) => c.toUpperCase() === ccy)) {
      throw new UnauthorizedException("currency_not_allowed");
    }

    // Phase 3: a play-money "fun mode" launch requires the operator to have demo play
    // ENABLED — a per-operator compliance capability, OFF by default (some jurisdictions
    // restrict demo gambling), set at provisioning. Checked here, before the jti is
    // consumed, so a rejected demo launch doesn't burn the token. A real-money launch
    // (demo absent/false) is unaffected. The flag is operator-signed, so only the
    // operator can request demo.
    const demo = payload.demo === true;
    if (demo && !op.demoEnabled) {
      throw new UnauthorizedException("demo_not_allowed");
    }

    // #1 — reject an absurdly-long operator-supplied playerId BEFORE the jti is consumed (no
    // GameSession is written yet, so the operator can re-issue a corrected token). A missing /
    // non-string playerId is also rejected here (it would otherwise become the string "undefined"
    // in the username tag). Bound, not auth — the token is already operator-signed.
    const playerId = payload.playerId;
    if (typeof playerId !== "string" || playerId.length < 1 || playerId.length > MAX_PLAYER_ID_LEN) {
      throw new UnauthorizedException("invalid_launch_token");
    }

    const jti = payload.jti as string | undefined;
    if (!jti) throw new UnauthorizedException("invalid_launch_token");

    // 3) one-time use: reject if this jti was already consumed by a session.
    const used = await this.prisma.gameSession.findUnique({ where: { launchJti: jti } });
    if (used) throw new UnauthorizedException("launch_token_already_used");

    return {
      operatorId,
      playerId, // validated above: a non-empty string ≤ MAX_PLAYER_ID_LEN
      currency: payload.currency,
      locale: normalizeLocale(payload.locale),
      demo,
      ctx: payload.ctx ?? {},
      jti,
    };
  }
}
