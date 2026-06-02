import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { extractClientIp } from "./client-ip";

// Rate-limit by the REAL client IP (CF-Connecting-IP) instead of the reverse
// proxy's address. Without this, all traffic behind Caddy/Cloudflare shares one
// 127.0.0.1 bucket — i.e. a single global limit for every user combined.
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return extractClientIp(req);
  }
}
