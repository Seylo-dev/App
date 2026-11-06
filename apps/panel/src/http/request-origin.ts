// The origin (scheme + host) a request was made to, for URLs the panel
// hands back to the same client: OAuth metadata, redirects. Behind our
// proxy the scheme comes from X-Forwarded-Proto; otherwise from the URL.

export function requestOrigin(request: Request, trustProxy: boolean): string {
  const url = new URL(request.url);
  const host = (trustProxy ? request.headers.get("x-forwarded-host") : null) ?? request.headers.get("host") ?? url.host;
  const forwarded = trustProxy ? request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() : undefined;
  const scheme = forwarded === "https" || forwarded === "http" ? forwarded : url.protocol.replace(":", "");
  return `${scheme}://${host}`;
}
