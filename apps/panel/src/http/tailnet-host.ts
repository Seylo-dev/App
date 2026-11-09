// The panel's tailnet listener (added in 0.2.1): a unix socket in the data
// dir that the owner's tailscaled proxies https://<machine>.<tailnet>.ts.net
// to (Tailscale Serve, set up by the panel node's agent).
//
// Trust: the socket is 0600 and owned by the panel's user, inside the 0700
// data dir, so only root (tailscaled) and the panel itself can connect.
// Serve's reverse proxy drops any X-Forwarded-* and Tailscale-User-* header
// the client sent and sets its own: X-Forwarded-For is the tailnet device,
// X-Forwarded-Host the Host the browser used, X-Forwarded-Proto "https" only
// in HTTPS mode (absent means http), and Tailscale-User-Login the device's
// user (none for tagged devices). The socket's deps therefore trust
// forwarded headers from every peer (panel.ts).
//
// Funnel: Serve marks a request from the internet with
// Tailscale-Funnel-Request (and drops one a client sent). Funnel covers a
// whole host and port, so `tailscale funnel` on another path of the panel's
// name would put the panel on the internet until the agent's next pass
// removes its entry. Those requests get a 403 here, whatever the agent does.
//
// Host pinning: Serve sends Host "localhost" to a unix target. The request
// is served only when X-Forwarded-Host is the server's MagicDNS name, and
// then Host is set to it, so origin checks, cookies and links see the name
// the browser used. The machine's short name or a tailnet address gets a
// 308 to the full name; anything else 421; while the panel does not know
// the name yet, 503; while the server is signed in to another tailnet than
// the one Serve was turned on for, 403. /api/health answers whatever the
// host: the agent's probe through the socket uses it.

import { chmodSync, lstatSync, rmSync } from "node:fs";
import type { AnyElysia } from "elysia";
import type { Logger } from "../logger";
import { healthPath } from "./health";
import { forwardedScheme } from "./request-origin";
import { panelWebsocket } from "./ws-guard";

/** The socket's file name in the panel's data dir; the agent points Serve at <host data dir>/panel/<this>. */
export const tailnetSocketName = "tailnet.sock";

/** What the listener knows of the server's tailnet identity (modules/tailscale). */
export interface TailnetIdentity {
  /** "panel.tail1234.ts.net"; null before the agent reported it. */
  dnsName: string | null;
  /** The machine's tailnet addresses (100.x, fd7a:115c:a1e0::). */
  addresses: readonly string[];
  /** The server is signed in to another tailnet than the one Serve was turned on for: nothing is served. */
  otherTailnet?: boolean;
}

export type TailnetHostVerdict =
  /** host: what Host becomes for the rest of the request; null keeps it (the health probe). */
  | { kind: "serve"; host: string | null }
  | { kind: "redirect"; location: string }
  | { kind: "misdirected" }
  | { kind: "unknown" }
  | { kind: "funnel" }
  | { kind: "otherTailnet" };

/** "Panel.tail1234.ts.net.:443" -> "panel.tail1234.ts.net"; "[fd7a::1]:80" -> "fd7a::1". */
function hostnameOf(host: string): string {
  const lower = host.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(lower);
  const name = bracketed ? (bracketed[1] as string) : lower.replace(/:\d+$/, "");
  return name.replace(/\.$/, "");
}

/** Decides one request on the tailnet listener. */
export function pinTailnetHost(request: Request, identity: TailnetIdentity): TailnetHostVerdict {
  // From the internet through Funnel: never served, not even the health check.
  if (request.headers.has("tailscale-funnel-request")) return { kind: "funnel" };
  const url = new URL(request.url);
  if (url.pathname === healthPath) return { kind: "serve", host: null };
  if (identity.otherTailnet) return { kind: "otherTailnet" };
  const dnsName = identity.dnsName?.trim().toLowerCase().replace(/\.$/, "") || null;
  if (!dnsName) return { kind: "unknown" };
  const host = request.headers.get("x-forwarded-host")?.trim() ?? "";
  const hostname = hostnameOf(host);
  const https = forwardedScheme(request.headers.get("x-forwarded-proto")) === "https";
  if (hostname === dnsName) {
    // The scheme's own port is left out, as browsers do in Origin.
    const port = /:(\d+)$/.exec(host)?.[1];
    return { kind: "serve", host: port && port !== (https ? "443" : "80") ? `${dnsName}:${port}` : dnsName };
  }
  const shortName = dnsName.split(".")[0];
  const addresses = new Set(identity.addresses.map((address) => address.toLowerCase()));
  if (hostname && (hostname === shortName || addresses.has(hostname))) {
    return { kind: "redirect", location: `${https ? "https" : "http"}://${dnsName}${url.pathname}${url.search}` };
  }
  return { kind: "misdirected" };
}

const plain = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });

/**
 * The tailnet app's first onRequest hook: answers what pinTailnetHost does
 * not serve, and sets Host to the pinned name for the rest of the request.
 */
export function tailnetHostGuard(identity: () => TailnetIdentity) {
  return ({ request }: { request: Request }): Response | undefined => {
    const verdict = pinTailnetHost(request, identity());
    switch (verdict.kind) {
      case "serve":
        if (verdict.host) request.headers.set("host", verdict.host);
        return undefined;
      case "redirect":
        return plain(308, `Moved to ${verdict.location}`, { location: verdict.location });
      case "unknown":
        return plain(503, "The panel does not know its tailnet name yet. Try again in a minute.", { "retry-after": "30" });
      case "misdirected":
        return plain(421, "This address does not serve the panel. Open the panel's tailnet name instead.");
      case "funnel":
        return plain(403, "The panel is not served over Tailscale Funnel.");
      case "otherTailnet":
        return plain(
          403,
          "The panel server is signed in to another tailnet than the one the panel was served on. Its owner has to turn Serve on again for this tailnet.",
        );
    }
  };
}

/**
 * The socket's user: Serve puts the device's login there, RFC 2047
 * Q-encoded when it is not ASCII ("=?utf-8?q?J=C3=B6rg?=").
 */
export function tailscaleUserLogin(request: Request): string | null {
  const raw = request.headers.get("tailscale-user-login")?.trim();
  if (!raw) return null;
  const words = raw.match(/^(=\?utf-8\?q\?[^?]*\?=\s*)+$/i) ? raw.match(/=\?utf-8\?q\?([^?]*)\?=/gi) : null;
  if (!words) return raw;
  try {
    const bytes: number[] = [];
    for (const word of words) {
      const text = word.slice(10, -2).replaceAll("_", " ");
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "=" && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
          bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(text.charCodeAt(i));
      }
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return raw;
  }
}

/**
 * Listens `app` on the unix socket at `path`: a socket left by a panel that
 * did not stop cleanly is removed first, and the new one is 0600 from the
 * start (umask) and after (chmod). A failure is logged and leaves the main
 * listener alone: the tailnet is one way in, not the panel.
 */
export function listenOnTailnetSocket(app: AnyElysia, path: string, logger: Logger): boolean {
  try {
    removeStaleSocket(path);
    const previous = process.umask(0o177);
    try {
      app.listen({ unix: path, websocket: panelWebsocket } as never);
    } finally {
      process.umask(previous);
    }
    chmodSync(path, 0o600);
    logger.info({ socket: path }, "tailnet listener ready");
    return true;
  } catch (error) {
    logger.error({ err: error, socket: path }, "the tailnet listener could not start; the panel is not reachable over Tailscale Serve");
    return false;
  }
}

/** Removes a socket file at `path`; anything else there is left alone (listen then fails and says so). */
function removeStaleSocket(path: string): void {
  let isSocket = false;
  try {
    isSocket = lstatSync(path).isSocket();
  } catch {
    return; // nothing there
  }
  if (isSocket) rmSync(path, { force: true });
}
