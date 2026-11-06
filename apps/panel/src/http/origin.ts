// Cookie-authenticated requests from another site must not act for the
// signed-in person. SameSite=Lax cookies already block most of this; the
// Origin check covers WebSockets and older browsers.

/** True when the request has no Origin (not a browser) or comes from this host. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
