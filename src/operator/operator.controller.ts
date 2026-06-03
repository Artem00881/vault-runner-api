import { Body, Controller, Post, BadRequestException, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { GameSessionService } from "./game-session.service";
import { JwtAuthGuard, CurrentWalletId } from "../auth/jwt-auth.guard";

const launchSchema = z.object({ token: z.string().min(10) });

@Controller("api/operator")
export class OperatorController {
  constructor(private readonly sessions: GameSessionService) {}

  /**
   * Open the game from an operator launch token.
   * The operator lobby sends the player here with a signed launch token; we
   * verify it (signature + expiry + one-time jti), create the session, and
   * return the session/wallet the client plays under.
   */
  @Post("launch")
  async launch(@Body() body: unknown) {
    const parsed = launchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid_body");
    return this.sessions.openFromToken(parsed.data.token);
  }

  /**
   * Close (revoke) the caller's session(s) — a logout. Authenticated by the player's
   * OWN session token; soft-revokes every live GameSession bound to that wallet so the
   * token can no longer reconnect/bet (isLive → false), while keeping the rows so the
   * operator-wallet resolver still serves any in-flight settlement (L-C2.2 trigger).
   * A guest (no session-bound wallet) is a no-op.
   */
  @Post("session/close")
  @UseGuards(JwtAuthGuard)
  async closeSession(@CurrentWalletId() walletId?: string) {
    const revoked = walletId ? await this.sessions.revokeForWallet(walletId) : 0;
    return { ok: true, revoked };
  }
}
