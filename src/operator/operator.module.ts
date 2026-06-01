import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { LaunchTokenService } from "./launch-token.service";
import { GameSessionService } from "./game-session.service";
import { OperatorController } from "./operator.controller";

/**
 * Operator (B2B multi-tenant) surface: launch-token verification and game
 * sessions. Launch tokens are signed PER OPERATOR with the operator's own
 * secret (passed explicitly to JwtService), so no global JWT secret is needed
 * here — JwtModule.register({}) just provides the sign/verify primitives.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [OperatorController],
  providers: [LaunchTokenService, GameSessionService],
  exports: [LaunchTokenService, GameSessionService],
})
export class OperatorModule {}
