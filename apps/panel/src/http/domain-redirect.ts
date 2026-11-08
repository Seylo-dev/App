// Once the panel domain is live, page loads on the node's IP:port go to the
// domain. The port stays published (agents that joined before the domain
// dial it, and the panel must answer while the agent restarts), but people
// should not type their password into a plain-HTTP page. API calls are left
// alone (CLI, scripts, agents); loopback stays open as the way back in over
// an SSH tunnel when the domain breaks. A domain that stops answering drops
// out of "active" at its next check (hourly while IP access is open, every
// 5 minutes while it is closed or the domain is not active), and from then
// IP:port pages are served again instead of redirected. Closing the port
// itself is Settings > General > "Serve on IP address" (modules/settings/
// ip-access.ts): then IP:port only answers on the server, where loopback
// is never redirected.

import type { Deps } from "../deps";
import "../modules/settings/domain";
import { getSetting } from "../settings";

const loopback = new Set(["localhost", "127.0.0.1", "::1"]);

/** Where a page request should go instead, or null to serve it. */
export function domainRedirect(deps: Pick<Deps, "db">, request: Request): string | null {
  const domain = getSetting(deps.db, "panelDomain")?.trim().toLowerCase();
  if (!domain) return null;
  const status = getSetting(deps.db, "panelDomainStatus");
  if (status?.domain !== domain || status.state !== "active") return null;
  const host = request.headers.get("host")?.toLowerCase() ?? "";
  if (host === domain) return null;
  const hostname = host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  if (loopback.has(hostname)) return null;
  const url = new URL(request.url);
  return `https://${domain}${url.pathname}${url.search}`;
}
