import { Injectable, Inject } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { LaunchTokenService } from "./launch-token.service";
import type { OperatorSession, SessionResolver } from "../wallet/seamless-operator-wallet";

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

    // Find or create the local journal wallet for this operator player+currency.
    // We tag the User.username with operator+player so it's unique & traceable.
    const tag = `op:${v.operatorId}:${v.playerId}:${v.currency}`;
    let wallet = await this.prisma.wallet.findFirst({
      where: { currency: v.currency, user: { username: tag } },
    });
    if (!wallet) {
      const user = await this.prisma.user.create({
        data: {
          id: randomUUID(),
          username: tag,
          isGuest: false,
          wallets: { create: { currency: v.currency, balance: 0n } }, // journal anchor
          profile: { create: { displayName: `Player ${v.playerId.slice(0, 6)}` } },
        },
        include: { wallets: true },
      });
      wallet = user.wallets[0];
    }

    // Consume the jti by recording the session (unique launchJti enforces
    // one-time use; a replayed token hits the unique constraint).
    const session = await this.prisma.gameSession.create({
      data: {
        operatorId: v.operatorId,
        playerId: v.playerId,
        currency: v.currency,
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
    const playToken = await this.jwt.signAsync({
      sub: wallet.userId,
      currency: v.currency,
      operatorId: v.operatorId,
      playerId: v.playerId,
      sessionId: session.id,
      kind: "operator",
    });

    return {
      token: playToken,
      sessionId: session.id,
      walletId: wallet.id,
      currency: v.currency,
      locale: v.locale,
    };
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
