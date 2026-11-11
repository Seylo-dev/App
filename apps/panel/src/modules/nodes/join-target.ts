// Where agents reach the panel: the URL and trust of the Add node dialog's
// join command (nodes/ops.ts createJoinToken; the command itself is
// nodes/join-command.ts). The master-key rotation script prints the same
// target for its re-join commands (security/rotate-master-key.ts), so this
// file stays free of op code. A target whose port IP access closed
// (settings/ip-access.ts) is refused: a node could not reach it.

import { isIP } from "node:net";
import { OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import type { Config } from "../../config";
import type { PanelDb } from "../../db/client";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { getSetting } from "../../settings";
import { privateIpv4Of, urlHost } from "../domains/lookup";
import type { PanelIpAccessApplied } from "../settings/ip-access";

export interface JoinContext {
  db: PanelDb;
  config: Pick<Config, "hostPort" | "port" | "host">;
  /** The address the caller reached the panel at, when there is one. */
  origin?: string | null;
}

export interface JoinTarget {
  url: string;
  pin: string | null;
  insecureTransport: boolean;
}

/**
 * The URL agents dial: the panel's domain when it has one, else the panel
 * node's public address (set by the owner or seeded at setup), else its
 * public IPv4, else the address the caller reached the panel at (only an
 * IP literal that is not loopback: a name the panel does not own, such as
 * a tailnet's ts.net name, is not where other servers reach it), else the
 * panel node's private IPv4. Loopback is the last resort: no other server
 * can dial it.
 */
export function panelUrl(ctx: JoinContext): string {
  const domain = getSetting(ctx.db, "panelDomain") ?? null;
  if (domain) return `https://${domain}`;
  return panelIpUrl(ctx);
}

/** panelUrl without the domain: where the panel answers on IP:port. */
export function panelIpUrl(ctx: JoinContext): string {
  const port = ctx.config.hostPort ?? ctx.config.port;
  const panelNode = ctx.db
    .select({ ipv4: nodes.publicIpv4, ipv6: nodes.publicIpv6, publicAddress: nodes.publicAddress, facts: nodes.facts })
    .from(nodes)
    .where(eq(nodes.isPanelNode, true))
    .get();
  if (panelNode?.publicAddress) return `http://${urlHost(panelNode.publicAddress)}:${port}`;
  if (panelNode?.ipv4) return `http://${panelNode.ipv4}:${port}`;
  // An IPv6-only panel node: its public address, bracketed.
  if (panelNode?.ipv6) return `http://[${panelNode.ipv6}]:${port}`;
  const origin = nonLoopbackOrigin(ctx.origin);
  if (origin) return origin;
  const privateIp = privateIpv4Of(panelNode?.facts);
  if (privateIp) return `http://${privateIp}:${port}`;
  const host = ctx.config.host;
  return `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`;
}

/** "http://192.168.1.5:3000" from the request origin: an IP literal that is not loopback, else null. */
function nonLoopbackOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) === 0) return null;
    if (host === "::1" || /^127\./.test(host) || host === "0.0.0.0" || host === "::") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The panel domain's last check found it active (the same rule agents move by, agent-hub/move-target.ts). */
function domainActive(db: PanelDb): boolean {
  const domain = getSetting(db, "panelDomain")?.trim().toLowerCase();
  const status = getSetting(db, "panelDomainStatus");
  return !!domain && status?.domain.trim().toLowerCase() === domain && status.state === "active";
}

/**
 * Where a new node's agent dials and how it trusts the panel: the domain
 * over HTTPS with its public certificate; else the agents' TLS port with
 * the panel's pinned key; else plain HTTP, which the join card warns about
 * (anyone on the path could read and inject the agent protocol).
 */
/**
 * The same join over the panel's IP address and agents' TLS port with its
 * pinned key, when agentJoinTarget picked the domain (no pin): for a server
 * whose network decrypts HTTPS on the way (TLS inspection re-signs the
 * domain's certificate, which the agent then refuses) or that cannot reach
 * the domain. Null without an agents' TLS port, with that port closed, or
 * when the panel knows no address other servers reach.
 */
export function agentPinnedTarget(ctx: JoinContext & Pick<Deps, "agentTls">, main: JoinTarget): JoinTarget | null {
  if (main.pin || !main.url.startsWith("https://") || !ctx.agentTls) return null;
  const applied: PanelIpAccessApplied | undefined = getSetting(ctx.db, "panelIpAccessApplied");
  if (applied?.agentPortClosed) return null;
  const host = new URL(panelIpUrl(ctx)).hostname;
  if (host === "localhost" || host === "[::1]" || /^127\./.test(host)) return null;
  return { url: `https://${host}:${ctx.agentTls.port}`, pin: ctx.agentTls.pin, insecureTransport: false };
}

export function agentJoinTarget(ctx: JoinContext & Pick<Deps, "agentTls">): JoinTarget {
  const url = panelUrl(ctx);
  const applied: PanelIpAccessApplied | undefined = getSetting(ctx.db, "panelIpAccessApplied");
  const agentPortClosed = () =>
    new OpError(
      "CONFLICT",
      "Open the agents' port first (Settings > General > Panel domain). New nodes join over it while the panel has no active domain.",
      { reason: "agentPortClosed" },
    );
  if (url.startsWith("https://")) {
    // A domain that is not active yet is no way in either while the agents' port is closed.
    if (applied?.agentPortClosed && !domainActive(ctx.db)) throw agentPortClosed();
    return { url, pin: null, insecureTransport: false };
  }
  const host = new URL(url).hostname;
  const loopback = host === "localhost" || host === "[::1]" || /^127\./.test(host);
  if (ctx.agentTls) {
    if (applied?.agentPortClosed && !loopback) throw agentPortClosed();
    return { url: `https://${host}:${ctx.agentTls.port}`, pin: ctx.agentTls.pin, insecureTransport: false };
  }
  if (applied?.closed && !loopback) {
    throw new OpError(
      "CONFLICT",
      "Turn Serve on IP address back on first (Settings > General > Panel domain). Without an agents' port or an active domain, new nodes join over the panel's IP address.",
      { reason: "ipAccessClosed" },
    );
  }
  return { url, pin: null, insecureTransport: !loopback };
}
