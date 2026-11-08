// Where agents reach the panel: the URL and trust of the Add node dialog's
// join command (nodes/ops.ts createJoinToken; the command itself is
// nodes/join-command.ts). The master-key rotation script prints the same
// target for its re-join commands (security/rotate-master-key.ts), so this
// file stays free of op code.

import { eq } from "drizzle-orm";
import type { Config } from "../../config";
import type { PanelDb } from "../../db/client";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { getSetting } from "../../settings";
import { privateIpv4Of, urlHost } from "../domains/lookup";

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
 * public IPv4, else the address the caller reached the panel at (unless
 * that is loopback), else the panel node's private IPv4. Loopback is the
 * last resort: no other server can dial it.
 */
export function panelUrl(ctx: JoinContext): string {
  const domain = getSetting(ctx.db, "panelDomain") ?? null;
  if (domain) return `https://${domain}`;
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

/** "http://192.168.1.5:3000" from the request origin, or null for loopback and unknown origins. */
function nonLoopbackOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host) || host === "0.0.0.0") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Where a new node's agent dials and how it trusts the panel: the domain
 * over HTTPS with its public certificate; else the agents' TLS port with
 * the panel's pinned key; else plain HTTP, which the join card warns about
 * (anyone on the path could read and inject the agent protocol).
 */
export function agentJoinTarget(ctx: JoinContext & Pick<Deps, "agentTls">): JoinTarget {
  const url = panelUrl(ctx);
  if (url.startsWith("https://")) return { url, pin: null, insecureTransport: false };
  const host = new URL(url).hostname;
  if (ctx.agentTls) return { url: `https://${host}:${ctx.agentTls.port}`, pin: ctx.agentTls.pin, insecureTransport: false };
  const loopback = host === "localhost" || host === "[::1]" || /^127\./.test(host);
  return { url, pin: null, insecureTransport: !loopback };
}
