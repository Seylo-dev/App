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
  const domain = getSetting(deps.db, "panelDomain")?.trim().toLowerCase();
  return !!domain && request.headers.get("host")?.toLowerCase() === domain;
}

/** Headers every panel response carries; HSTS only on HTTPS. */
export function securityHeaders(https: boolean): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    // Nothing of the panel is meant to be framed: a page on a member's app
    // (same site as the panel) could otherwise lay a fake button over it.
    "x-frame-options": "DENY",
    ...(https ? { "strict-transport-security": "max-age=31536000" } : {}),
  };
}
