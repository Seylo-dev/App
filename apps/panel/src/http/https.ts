// Whether a request reached the panel over HTTPS. Behind the node's Traefik
// the scheme comes from X-Forwarded-Proto of a trusted proxy; a request for
// the panel domain itself (no port) only ever arrives through Traefik's
// HTTPS router, since its HTTP router answers with a redirect. A forged Host
// header only marks the forger's own response.

import type { Deps } from "../deps";
import { getSetting } from "../settings";
import { requestOrigin } from "./request-origin";

export function servedOverHttps(deps: Pick<Deps, "db" | "proxy">, request: Request, socketIp: string | null): boolean {
  if (requestOrigin(request, deps.proxy.trusts(socketIp)).startsWith("https://")) return true;
  let domain: string | undefined;
  try {
    domain = getSetting(deps.db, "panelDomain")?.trim().toLowerCase();
  } catch {
    // An unreadable database must not fail every request here, before the
    // route runs: /api/health has to answer 503 for it, and other routes
    // fail on their own reads.
    return false;
  }
  return !!domain && request.headers.get("host")?.toLowerCase() === domain;
}

/**
 * Whether the session cookie of this request is the Secure `__Host-` one:
 * on every HTTPS request (so a session made on the panel domain is never
 * sent over plain HTTP), or always with SECURE_COOKIES. IP:port sign-in
 * keeps a plain cookie. Setting and reading the cookie use the same rule.
 */
export function secureSession(deps: Pick<Deps, "db" | "proxy" | "config">, request: Request, socketIp: string | null): boolean {
  return deps.config.secureCookies || servedOverHttps(deps, request, socketIp);
}

/** Headers every panel response carries; HSTS only when asked (HTTPS on the main listener). */
export function securityHeaders(options: { hsts: boolean }): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    // Nothing of the panel is meant to be framed: a page on a member's app
    // (same site as the panel) could otherwise lay a fake button over it.
    "x-frame-options": "DENY",
    ...(options.hsts ? { "strict-transport-security": "max-age=31536000" } : {}),
  };
}
