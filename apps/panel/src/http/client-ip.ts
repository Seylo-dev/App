// The caller's IP for rate limits and the audit log. X-Forwarded-For is
// only believed when the socket peer is a trusted proxy (proxy-trust.ts);
// behind Cloudflare, CF-Connecting-IP only when that proxy saw a Cloudflare
// address (cloudflare.ts). Addresses come back normalised (normalizeIp), so
// "::ffff:203.0.113.5" and "203.0.113.5" are one caller.

import { isIP } from "node:net";
import { isCloudflareAddress } from "./cloudflare";
import { normalizeIp } from "./proxy-trust";

export function clientIp(request: Request, socketIp: string | null, trustProxy: boolean): string | null {
  if (trustProxy) {
    // The proxy appends the address it saw, so the last entry is the one
    // it vouches for; earlier entries are whatever the client claimed.
    const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) {
      const visitor = request.headers.get("cf-connecting-ip")?.trim();
      if (visitor && isIP(visitor) !== 0 && isCloudflareAddress(forwarded)) return normalizeIp(visitor);
      return normalizeIp(forwarded);
    }
  }
  return socketIp === null ? null : normalizeIp(socketIp);
}
