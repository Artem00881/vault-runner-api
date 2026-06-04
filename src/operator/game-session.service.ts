import { Injectable, Inject } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { LaunchTokenService } from "./launch-token.service";
import type { OperatorSession, SessionResolver } from "../wallet/seamless-operator-wallet";
import { effectiveLimitsFor, serializeBetLimits } from "./bet-limits";

// Operator session ("play") tokens are SHORT-lived (re-launch to refresh), unlike
// 30-day guest tokens — this limits how long a leaked session token is usable, and the
// sessionId is re-validated against a live GameSession at WS connect (audit L-C2.2).
// Env-tunable but CLAMPED to 60s..24h so neither a too-low nor an absurdly-high
// (control-weakening) value can take effect; out-of-range/non-numeric → default 4h.
const SESSION_TOKEN_TTL_SEC = (() => {
  const n = Number(process.env.SESSION_TOKEN_TTL_SEC);
  return Number.isFinite(n) && n >= 60 && n <= 86400 ? n : 14400;
})();

/**
 * Turns a verified launch token into a live game session, and resolves a local
 * walletId back to the operator-side session for the SeamlessOperatorWallet.
 *
 * In operator (real-money) mode the OPERATOR's wallet is the source of truth;
 * the local wallet here is just a journal anchor (balance not authoritative —
 * the provider reads the real balance from the operator). One operator player +
 * currency reuses the same local wallet across launches.
 */
@Injectable()
export class GameSessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LaunchTokenService) private readonly launch: LaunchTokenService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  /** Open the game from an operator launch token → create (consume) a session. */
  async openFromToken(token: string) {
    const v = await this.launch.verify(token); // signature + expiry + jti unused

    // Canonical currency (ISO-4217 uppercase) so the journal wallet key, session,
    // and per-currency bet-limit lookup are all consistent regardless of the casing
    // the operator sent (verify()'s allow-list check is likewise case-insensitive).
    const currency = (v.currency ?? "").toUpperCase();

    // The operator's per-currency PER-BET limits for this session's currency
    // (Phase 3). null → the player plays under the global house defaults.
    const op = await this.prisma.operator.findUnique({
      where: { id: v.operatorId },
      select: { betLimits: true },
    });
    const limits = effectiveLimitsFor(op?.betLimits, currency);

    // Find or create the local journal wallet for this operator player+currency.
    // We tag the User.username with operator+player so it's unique & traceable.
    const tag = `op:${v.operatorId}:${v.playerId}:${currency}`;
    let wallet = await this.prisma.wallet.findFirst({
      where: { currency, user: { username: tag } },
    });
    if (!wallet) {
      try {
        const user = await this.prisma.user.create({
          data: {
            id: randomUUID(),
            username: tag,
            isGuest: false,
            wallets: { create: { currency, balance: 0n } }, // journal anchor
            profile: { create: { displayName: `Player ${v.playerId.slice(0, 6)}` } },
          },
          include: { wallets: true },
        });
        wallet = user.wallets[0];
      } catch (e) {
        // Concurrent FIRST launch for this player won the race and created the
        // user+wallet (username is UNIQUE) — re-find it instead of 500-ing the
        // second launch (audit L-C2.1: concurrent first-launch is idempotent).
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          wallet = await this.prisma.wallet.findFirstOrThrow({
            where: { currency, user: { username: tag } },
          });
        } else {
          throw e;
        }
      }
    }

    // Consume the jti by recording the session (unique launchJti enforces
    // one-time use; a replayed token hits the unique constraint).
    const session = await this.prisma.gameSession.create({
      data: {
        operatorId: v.operatorId,
        playerId: v.playerId,
        currency,
        locale: v.locale,
        walletId: wallet.id,
        launchJti: v.jti,
      },
    });

    // Issue a SESSION ("play") token the client uses for the WebSocket handshake
    // — signed with OUR JWT_SECRET (same as a guest token) so the gateway
    // verifies it identically. `sub` is the LOCAL user id (the socket/bet
    // identity); the bet path resolves THIS user's own wallet (its currency),
    // and in operator mode money routes to the operator via resolver() below.
    const playToken = await this.jwt.signAsync(
      {
        sub: wallet.userId,
        walletId: wallet.id, // the session's bound wallet — placeBet resolves THIS one (audit M-C2.1)
        currency,
        operatorId: v.operatorId,
        playerId: v.playerId,
        sessionId: session.id,
        kind: "operator",
        // Phase 3: the session's resolved per-currency bet limits ride with the play
        // token so the gateway applies them on every bet with no extra lookup.
        // Absent → the bet path falls back to the global house defaults.
        ...(limits ? { limits: serializeBetLimits(limits) } : {}),
      },
      { expiresIn: SESSION_TOKEN_TTL_SEC }, // short-lived session token (audit L-C2.2)
    );

    return {
      token: playToken,
      sessionId: session.id,
      walletId: wallet.id,
      currency,
      locale: v.locale,
    };
  }

  /**
   * Is this session id still a live GameSession? The WebSocket gateway calls this at
   * connect for an operator session token, so a revoked/removed session is rejected
   * even though the (short-lived) JWT itself may not yet have expired (audit L-C2.2).
   */
  async isLive(sessionId: string): Promise<boolean> {
    return (await this.prisma.gameSession.count({ where: { id: sessionId, revokedAt: null } })) > 0;
  }

  /**
   * Soft-revoke every live session bound to this wallet — the L-C2.2 revocation TRIGGER
   * (e.g. a player logout). Sets `revokedAt` so `isLive()` rejects the session at WS
   * connect; the rows are KEPT so the operator-wallet resolver still serves any in-flight
   * settlement for that wallet. Idempotent (already-revoked rows are skipped via the
   * `revokedAt: null` filter). Returns how many sessions were revoked.
   */
  async revokeForWallet(walletId: string): Promise<number> {
    const r = await this.prisma.gameSession.updateMany({
      where: { walletId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return r.count;
  }

  /**
   * SessionResolver for SeamlessOperatorWallet: walletId → operator session.
   * Every GameSession for a given walletId shares the SAME (operatorId,
   * playerId, currency) by construction (the wallet is keyed to one operator
   * player+currency), so any session yields identical routing — we take the
   * most recent by createdAt. (NB: GameSession.lastSeenAt is @updatedAt but is
   * never written, so it must NOT be used to order — audit M-C2.2.)
   */
  resolver(): SessionResolver {
    return async (walletId: string): Promise<OperatorSession> => {
      const session = await this.prisma.gameSession.findFirstOrThrow({
        where: { walletId },
        orderBy: { createdAt: "desc" },
      });
      return {
        operatorId: session.operatorId,
        playerId: session.playerId,
        currency: session.currency,
      };
    };
  }
}
