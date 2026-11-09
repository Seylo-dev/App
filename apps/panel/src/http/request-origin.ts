// The origin (scheme + host) a request was made to, for URLs the panel
// hands back to the same client: OAuth metadata, redirects. Behind our
// proxy the scheme comes from X-Forwarded-Proto; otherwise from the URL.

export function requestOrigin(request: Request, trustProxy: boolean): string {
  const url = new URL(request.url);
  const host = (trustProxy ? request.headers.get("x-forwarded-host") : null) ?? request.headers.get("host") ?? url.host;
  const forwarded = trustProxy ? forwardedScheme(request.headers.get("x-forwarded-proto")) : null;
  const scheme = forwarded ?? url.protocol.replace(":", "");
  return `${scheme}://${host}`;
}

/**
 * The scheme an X-Forwarded-Proto value stands for: "https" or "http", or
 * null for anything else. Traefik sends "wss" and "ws" for WebSocket
 * upgrades, so an agent that connected through the panel domain was taken
 * for plain http:// (the IP access and domain guards then saw every moved
 * node as a plain-HTTP one).
 */
export function forwardedScheme(header: string | null | undefined): "https" | "http" | null {
  const value = header?.split(",")[0]?.trim().toLowerCase();
  if (value === "https" || value === "wss") return "https";
  if (value === "http" || value === "ws") return "http";
  return null;
}
