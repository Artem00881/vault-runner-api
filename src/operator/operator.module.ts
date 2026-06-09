import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { buildJwtOptions } from "../auth/auth.module";
import { LedgerModule } from "../wallet/ledger.module";
import { LaunchTokenService } from "./launch-token.service";
import { GameSessionService } from "./game-session.service";
import { OperatorController } from "./operator.controller";
import { OperatorSessionsController } from "./operator-sessions.controller";
import { ReportingController } from "./reporting.controller";
import { AuditEventsController } from "./audit-events.controller";
import { ReportingService } from "./reporting.service";
import { OperatorAuthGuard } from "./operator-auth.guard";
import { OperatorThrottlerGuard } from "./operator-throttler.guard";

/**
 * Operator (B2B multi-tenant) surface: launch-token verification and game
 * sessions. Launch tokens are VERIFIED per operator with the operator's own
 * secret (passed explicitly to JwtService). The session ("play") token we ISSUE
 * at launch is signed with OUR global JWT_SECRET (via buildJwtOptions — the same
 * config AuthModule uses), so the WebSocket gateway verifies it exactly like a
 * guest token (audit C2: operator players need a socket identity too).
 */
@Module({
  imports: [
    JwtModule.registerAsync({ inject: [ConfigService], useFactory: buildJwtOptions }),
    LedgerModule, // GameSessionService seeds/resets demo (fun-mode) play-money wallets
  ],
  controllers: [OperatorController, OperatorSessionsController, ReportingController, AuditEventsController],
  // ReportingService + OperatorAuthGuard need only PrismaService (global; Reflector + the
  // ThrottlerModule providers are global too). Both guards are registered so
  // @UseGuards(OperatorAuthGuard, OperatorThrottlerGuard) resolves them with their deps.
  providers: [LaunchTokenService, GameSessionService, ReportingService, OperatorAuthGuard, OperatorThrottlerGuard],
  // Both guards are exported so the GameModule's operator-facing controllers (e.g. the bet-void
  // endpoint, which lives with BetsService) can reuse the same per-operator reporting-key auth +
  // tenant scoping (Phase 6) and the per-operator rate-limit (write-route shared gate).
  exports: [LaunchTokenService, GameSessionService, OperatorAuthGuard, OperatorThrottlerGuard],
})
export class OperatorModule {}
