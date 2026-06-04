import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { buildJwtOptions } from "../auth/auth.module";
import { LedgerModule } from "../wallet/ledger.module";
import { LaunchTokenService } from "./launch-token.service";
import { GameSessionService } from "./game-session.service";
import { OperatorController } from "./operator.controller";

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
  controllers: [OperatorController],
  providers: [LaunchTokenService, GameSessionService],
  exports: [LaunchTokenService, GameSessionService],
})
export class OperatorModule {}
