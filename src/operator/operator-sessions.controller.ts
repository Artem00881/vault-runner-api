import { BadRequestException, Body, Controller, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { CurrentOperatorId, OperatorAuthGuard, RequireWriteScope } from "./operator-auth.guard";
import { OperatorThrottlerGuard } from "./operator-throttler.guard";
import { GameSessionService } from "./game-session.service";

/**
 * Operator-facing "TERMINATE ACTIVE SESSION" surface (F-068, M3). Authenticated by the
 * per-operator reporting API key (the SAME OperatorAuthGuard as the reporting / void / audit
 * routes) and HARD-scoped to that operator — the operatorId comes ONLY from @CurrentOperatorId,
 * never the body — so an operator can revoke ONLY its OWN players. Lets an operator force-end a
 * player's live game session(s) out-of-band (e.g. the operator's own RG / self-exclusion system
 * cuts the player off): soft-revokes every live GameSession bound to the player's wallet(s) so
 * the session token can no longer reconnect or place a bet (isLive → false), while keeping the
 * rows so the operator-wallet resolver still serves any in-flight settlement. The connected
 * socket (if any) is dropped by the gateway RG sweep's batched liveness re-check shortly after.
 *
 *   POST /api/operator/sessions/revoke   { playerId, currency? }
 *     → { ok, revoked, wallets }   (idempotent; a re-revoke returns revoked:0)
 */
const revokeSchema = z.object({
  playerId: z.string().min(1).max(256),
  currency: z.string().min(1).max(16).optional(),
});

// WRITE scope (@RequireWriteScope): terminating a player's live session is a state-MOVING action,
// so it requires the operator's WRITE key (writeApiKeyHash), not the read/reporting key — and is
// rate-limited under the tighter per-operator WRITE budget. Fail-closed if no write key is set.
@Controller("api/operator/sessions")
@UseGuards(OperatorAuthGuard, OperatorThrottlerGuard)
@RequireWriteScope()
export class OperatorSessionsController {
  constructor(private readonly sessions: GameSessionService) {}

  @Post("revoke")
  async revoke(@CurrentOperatorId() operatorId: string, @Body() body: unknown) {
    const parsed = revokeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid_body");
    // operatorId is the AUTHENTICATED tenant — the service builds the wallet tag from it, so a
    // body can never widen the scope to another operator's player (cross-tenant revoke).
    const r = await this.sessions.revokeForOperatorPlayer(operatorId, parsed.data.playerId, parsed.data.currency);
    return { ok: true, ...r };
  }
}
