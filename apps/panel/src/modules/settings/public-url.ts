// The URL people and agents use to reach the panel right now, for links in
// alerts, the MCP URL and OAuth metadata. In order:
//   1. the panel domain once it is set;
//   2. the configured public URL (SEYLO_PUBLIC_URL);
//   3. the tailnet URL, only while IP access is closed and the tailnet path
//      works (added in 0.2.1): then IP:port does not answer from outside;
//   4. the panel node's address (its public address, public IP, private IP)
//      and the panel port.

import { asc, desc } from "drizzle-orm";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { getSetting } from "../../settings";
import { nodeAddress, privateIpv4Of } from "../domains/lookup";
import { readIpAccessApplied } from "./ip-access";
import { privatePathSources } from "./private-paths";
import "./keys";

/** Callers with the agent hub get the tailnet URL; the tailnet path needs it to judge its agent. */
type UrlDeps = Pick<Deps, "db" | "config"> & Partial<Pick<Deps, "agents">>;

export function panelPublicUrl(deps: UrlDeps): string {
  const domain = getSetting(deps.db, "panelDomain");
  if (domain) return `https://${domain}`;
  if (deps.config.publicUrl) return deps.config.publicUrl;
  return tailnetUrl(deps) ?? panelIpUrl(deps);
}

/** The tailnet URL while it is the way in: IP access closed and the tailnet path working. */
function tailnetUrl(deps: UrlDeps): string | null {
  const { agents } = deps;
  if (!agents || !readIpAccessApplied(deps).closed) return null;
  const tailnet = privatePathSources().find((source) => source.kind === "tailnet");
  const state = tailnet?.state({ db: deps.db, agents });
  return state?.working && state.url ? state.url : null;
}

/** http://<panel node address>:<panel port>, whether or not it answers from outside right now. */
export function panelIpUrl(deps: Pick<Deps, "db" | "config">): string {
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
export function panelLink(deps: UrlDeps, path: string | null): string | null {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  return `${panelPublicUrl(deps)}${path.startsWith("/") ? "" : "/"}${path}`;
}
