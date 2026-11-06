// The URL people and agents use to reach the panel right now: the panel
// domain once it is set, else the configured public URL, else the panel
// node's address (its public address, public IP, private IP) and the panel port. Used for links in alerts, the MCP
// URL and OAuth metadata.

import { asc, desc } from "drizzle-orm";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { getSetting } from "../../settings";
import { nodeAddress, privateIpv4Of } from "../domains/lookup";
import "./keys";

export function panelPublicUrl(deps: Pick<Deps, "db" | "config">): string {
  const domain = getSetting(deps.db, "panelDomain");
  if (domain) return `https://${domain}`;
  if (deps.config.publicUrl) return deps.config.publicUrl;
  const node = deps.db
    .select({ ipv4: nodes.publicIpv4, ipv6: nodes.publicIpv6, publicAddress: nodes.publicAddress, facts: nodes.facts })
    .from(nodes)
    .orderBy(desc(nodes.isPanelNode), asc(nodes.createdAt))
    .limit(1)
    .get();
  const host = (node && nodeAddress({ ...node, privateIpv4: privateIpv4Of(node.facts) })) ?? "localhost";
  return `http://${host}:${deps.config.hostPort ?? deps.config.port}`;
}

/** An absolute link for an in-app path such as "/p/abc/s/def". */
export function panelLink(deps: Pick<Deps, "db" | "config">, path: string | null): string | null {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  return `${panelPublicUrl(deps)}${path.startsWith("/") ? "" : "/"}${path}`;
}
