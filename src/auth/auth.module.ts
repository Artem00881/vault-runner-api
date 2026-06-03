import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule, type JwtModuleOptions } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";

/**
 * Build the JwtModule options from config, failing CLOSED (audit C3): a missing
 * secret aborts boot rather than silently downgrading auth to a hardcoded
 * default. Exported (and named) so the security invariant is unit-testable.
 */
export function buildJwtOptions(config: ConfigService): JwtModuleOptions {
  const secret = config.get<string>("JWT_SECRET");
  if (!secret) {
    throw new Error("JWT_SECRET is required (no insecure default) — set it via env / 1Password.");
  }
  if (secret.length < 32) {
    // eslint-disable-next-line no-console
    console.warn("[security] JWT_SECRET is shorter than 32 chars — use a long random secret in production.");
  }
  return {
    secret,
    signOptions: { expiresIn: "30d", algorithm: "HS256" },
    verifyOptions: { algorithms: ["HS256"] },
  };
}

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: buildJwtOptions,
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
