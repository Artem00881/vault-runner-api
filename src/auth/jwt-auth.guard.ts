import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth: string | undefined = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) throw new UnauthorizedException("missing_token");
    try {
      const payload = await this.jwt.verifyAsync(auth.slice(7));
      req.userId = payload.sub;
      req.walletId = payload.walletId; // operator session binds a specific wallet (M-C2.1); undefined for guests
      return true;
    } catch {
      throw new UnauthorizedException("invalid_token");
    }
  }
}

/** Inject the authenticated user id resolved by JwtAuthGuard. */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest().userId,
);

/** Inject the session-bound walletId from the token (operator sessions), or undefined (guests). */
export const CurrentWalletId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => ctx.switchToHttp().getRequest().walletId,
);
