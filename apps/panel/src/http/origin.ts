// Cookie-authenticated requests from another site must not act for the
// signed-in person. SameSite=Lax cookies already block most of this; the
// Origin check covers WebSockets and older browsers.
//
// The host compared is the Host header. X-Forwarded-Host counts only when
// the socket peer is a trusted proxy (proxy-trust.ts), like everywhere else
// the panel reads forwarded headers: any client can send that header, and
// believing it would let a request name its own "same" origin. Traefik keeps
// the browser's Host header, so the plain Host check holds behind it too.

/** True when the request has no Origin (not a browser) or comes from this host. */
export function isSameOrigin(request: Request, trusted = false): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = (trusted ? request.headers.get("x-forwarded-host") : null) ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
