import { Injectable, Inject, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

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
  /** optional per-launch limit/round context */
  ctx?: Record<string, unknown>;
}

export interface VerifiedLaunch extends LaunchClaims {
  jti: string;
  locale: string;
}

const TTL_SECONDS = 120;

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
        locale: claims.locale ?? "en",
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
    // corrected token.
    if (!op.currencies.includes(payload.currency)) {
      throw new UnauthorizedException("currency_not_allowed");
    }

    const jti = payload.jti as string | undefined;
    if (!jti) throw new UnauthorizedException("invalid_launch_token");

    // 3) one-time use: reject if this jti was already consumed by a session.
    const used = await this.prisma.gameSession.findUnique({ where: { launchJti: jti } });
    if (used) throw new UnauthorizedException("launch_token_already_used");

    return {
      operatorId,
      playerId: payload.playerId,
      currency: payload.currency,
      locale: payload.locale ?? "en",
      ctx: payload.ctx ?? {},
      jti,
    };
  }
}
