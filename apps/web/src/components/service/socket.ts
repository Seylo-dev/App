// WebSockets opened with a single-use ticket (logs, console, shell). The
// ticket ops return a path on the panel with the ticket as ?t=; this turns
// it into a ws:// or wss:// URL on the page's own origin.

/** "/api/terminal/shell?t=abc" on https://panel.example.com -> wss://panel.example.com/api/terminal/shell?t=abc */
export function toWebSocketUrl(pathOrUrl: string, base: { href: string; protocol: string }): string {
  const url = new URL(pathOrUrl, base.href);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

/** Adds ?t=<ticket> unless the path already carries one. */
export function withTicket(path: string, ticket: string): string {
  if (/[?&]t=/.test(path)) return path;
  return `${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(ticket)}`;
}

/** Reconnect delay: 1s, 2s, 4s ... up to 15s. */
export function backoffMs(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, attempt));
}

export function openSocket(pathOrUrl: string): WebSocket {
  const ws = new WebSocket(toWebSocketUrl(pathOrUrl, window.location));
  ws.binaryType = "arraybuffer";
  return ws;
}
