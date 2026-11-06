// Fetches a URL from an address that was already checked, so DNS cannot
// answer one thing to the check and another to the request (rebinding).
// The URL's host stays in the Host header and, for HTTPS, in SNI and the
// certificate check (Bun's tls.serverName).

import { isIP } from "node:net";

export interface PinnedRequest {
  url: string;
  headers: Record<string, string>;
  tls?: { serverName: string };
}

/** The request to send to `address` for `url`; unchanged when no address is pinned or the host is already one. */
export function pinRequest(url: string, address: string | null | undefined): PinnedRequest {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!address || isIP(hostname) !== 0) return { url, headers: {} };
  const host = parsed.host;
  parsed.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return {
    url: parsed.toString(),
    headers: { host },
    ...(parsed.protocol === "https:" ? { tls: { serverName: hostname } } : {}),
  };
}
