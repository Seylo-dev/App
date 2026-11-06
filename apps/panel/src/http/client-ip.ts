// The caller's IP for rate limits and the audit log. X-Forwarded-For is
// only believed when the panel is configured to sit behind our proxy.

export function clientIp(request: Request, socketIp: string | null, trustProxy: boolean): string | null {
  if (trustProxy) {
    // The proxy appends the address it saw, so the last entry is the one
    // it vouches for; earlier entries are whatever the client claimed.
    const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return socketIp;
}
