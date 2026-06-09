import { BadRequestException, Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentOperatorId, OperatorAuthGuard, RequireWriteScope } from "../operator/operator-auth.guard";
import { OperatorThrottlerGuard } from "../operator/operator-throttler.guard";
import { BetsService } from "./bets.service";
import { UUID_RE } from "../common/uuid";

/**
 * Operator-facing money action on a SINGLE bet (Phase 6). Authenticated by the
 * per-operator reporting API key (OperatorAuthGuard) and HARD-scoped to that operator
 * — the operatorId comes ONLY from @CurrentOperatorId, and voidBet re-checks
 * bet.operatorId (a bet that isn't this operator's → 404, no cross-tenant oracle).
 * Lives in the GameModule because it drives BetsService (the bet/money state machine);
 * the guard is reused via OperatorModule's export.
 *
 *   POST /api/operator/bets/:betId/void   { reason? }
 *     → fully reverse a SETTLED bet (refund stake; reclaim payout if it won).
 *       Idempotent + tenant-scoped. See bets.service.ts voidBet for the rules.
 *
 * WRITE scope (@RequireWriteScope, write-route shared gate): this MOVES money, so it requires the
 * operator's WRITE key (writeApiKeyHash) — NOT the read/reporting key — and is rate-limited under
 * the tighter per-operator WRITE budget. Fail-closed if no write key is provisioned.
 */
@Controller("api/operator/bets")
@UseGuards(OperatorAuthGuard, OperatorThrottlerGuard)
@RequireWriteScope()
export class OperatorBetsController {
  constructor(private readonly bets: BetsService) {}

  @Post(":betId/void")
  async void(
    @CurrentOperatorId() operatorId: string,
    @Param("betId") betId: string,
    @Body() body: unknown,
  ) {
    if (!UUID_RE.test(betId)) throw new BadRequestException("invalid betId");
    return this.bets.voidBet(operatorId, betId, readReason(body));
  }
}

/**
 * Read an optional, length-capped string `reason` off the body (only the known key —
 * prototype-pollution safe; a non-string is treated as absent). Control characters are
 * dropped by code point (it is logged → no newline/ANSI log-injection) and whitespace
 * is collapsed. Done with numeric code checks (no control-char literals in source).
 */
function readReason(body: unknown): string | undefined {
  const r = (body as { reason?: unknown } | null)?.reason;
  if (typeof r !== "string") return undefined;
  let cleaned = "";
  for (const ch of r) {
    const code = ch.charCodeAt(0);
    cleaned += code < 0x20 || code === 0x7f ? " " : ch;
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 500) : undefined;
}
