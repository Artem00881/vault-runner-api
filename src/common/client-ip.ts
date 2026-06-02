// Extract the real client IP for rate-limiting.
//
// Only Cloudflare can reach the origin (mTLS-enforced at the edge), so the
// `CF-Connecting-IP` header is trustworthy — a client cannot spoof it because it
// cannot connect to the origin directly. Fall back to the first X-Forwarded-For
// hop, then the socket address (local/dev with no proxy in front).
export interface IpRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export function extractClientIp(req: IpRequestLike): string {
  const cf = req.headers?.["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  const xff = req.headers?.["x-forwarded-for"];
  const xffStr = Array.isArray(xff) ? xff[0] : xff;
  if (typeof xffStr === "string" && xffStr.trim()) return xffStr.split(",")[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}
