import { BadRequestException, Body, Controller, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { CurrentOperatorId, OperatorAuthGuard, RequireWriteScope } from "../operator/operator-auth.guard";
import { OperatorThrottlerGuard } from "../operator/operator-throttler.guard";
import { DataErasureService } from "./data-erasure.service";

/**
 * Operator-facing GDPR "right to erasure" (R-039) — anonymize ONE OF THE OPERATOR'S OWN players
 * over HTTP, for a data-subject erasure request. The destructive complement to the read/void
 * surface; it reuses the SAME DataErasureService the CLI + retention sweep use, so it inherits
 * every safety property unchanged: it anonymizes PII IN PLACE and RETAINS the entire money journal
 * (wallets / ledger / bets), and it FAILS CLOSED if the player still has money in flight (a
 * non-terminal bet or a live session) — settle/void first.
 *
 *   POST /api/operator/players/:playerId/erase   { currency?, reason? }
 *     → { ok:true, playerId, alreadyAnonymized, usersAffected, scrubbedFields }
 *       Idempotent: a re-erase of an already-anonymized player returns alreadyAnonymized:true.
 *
 * TENANT-SCOPED by construction (no cross-tenant erase): operatorId comes ONLY from
 * @CurrentOperatorId (the authenticated key — never the path/body), and anonymizePlayer resolves
 * the player by the `op:{operatorId}:{playerId}:` username TAG built from THAT operatorId. A
 * playerId that isn't this operator's resolves to zero local users — IDENTICALLY to a playerId
 * that never existed — so we map that single "0 users" outcome to 404. There is therefore NO
 * existence oracle: "not your player" and "no such player" are indistinguishable (same 404), and a
 * genuine erase that DID match never returns 0. (Mirrors the bet-void / transaction-status 404.)
 *
 * WRITE scope (@RequireWriteScope, write-route shared gate): erasure is a destructive, state-MOVING
 * action, so it requires the operator's WRITE key (writeApiKeyHash) — NOT the read/reporting key —
 * and is rate-limited under the tighter per-operator WRITE budget. Fail-closed if no write key is
 * provisioned. The erasure itself is audit-logged by DataErasureService (operatorId + the
 * pseudonymous internal userId + which fields were scrubbed — NEVER the raw playerId/PII).
 */
const eraseSchema = z.object({
  // The operator's player id. Capped at 256 (matches the session-revoke route + #1 operatorTxId
  // cap) — an operator-supplied free string that flows into the username tag / index lookups.
  currency: z.string().min(1).max(16).optional(),
  reason: z.string().max(500).optional(),
});

@Controller("api/operator/players")
@UseGuards(OperatorAuthGuard, OperatorThrottlerGuard)
@RequireWriteScope()
export class OperatorErasureController {
  constructor(private readonly erasure: DataErasureService) {}

  @Post(":playerId/erase")
  async erase(
    @CurrentOperatorId() operatorId: string,
    @Param("playerId") playerId: string,
    @Body() body: unknown,
  ) {
    // Cap the path-supplied playerId too (it never reaches a DB write here — anonymizePlayer only
    // READS by the tag prefix — but an unbounded operator string shouldn't hit the index lookups).
    if (typeof playerId !== "string" || playerId.length < 1 || playerId.length > 256) {
      throw new BadRequestException("invalid_player_id");
    }
    const parsed = eraseSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException("invalid_body");

    const result = await this.erasure.anonymizePlayer({
      // operatorId is the AUTHENTICATED tenant — anonymizePlayer builds the resolution tag from it,
      // so a path/body can never widen scope to another operator's player.
      operatorId,
      playerId,
      currency: parsed.data.currency,
      actor: `operator:${operatorId}`,
      reason: parsed.data.reason,
    });

    // 0 users resolved = "not this operator's player" OR "no such player" — the SAME 404, no oracle.
    // (anonymizePlayer returns usersAffected>0 whenever it actually matched this operator's player,
    // including the already-anonymized idempotent case — which is reported as a 200 below.)
    if (result.usersAffected === 0) throw new NotFoundException("player_not_found");

    return {
      ok: true,
      playerId,
      alreadyAnonymized: result.alreadyAnonymized,
      usersAffected: result.usersAffected,
      scrubbedFields: result.scrubbedFields,
    };
  }
}
