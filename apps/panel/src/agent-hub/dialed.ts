// Which panel address each node's agent dials (added in 0.2.1), kept in
// panel.db so it is known while the node is offline and after a panel
// restart. The panel access guards (modules/settings/panel-access.ts) read
// it: closing IP access is refused while an enabled node dials plain
// http://, and closing the agents' port while a node dials anything but
// https://<panel domain>. Recorded when a session starts, from
// hub.dialedAddress (the base URL the agent's connect reached).

import { eq, isNull } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { nodes } from "../db/schema";
import type { Deps } from "../deps";
import { getSetting, setSetting } from "../settings";

export interface StoredDialedUrl {
  /** "https://panel.example.com", "https://203.0.113.4:3443" or "http://203.0.113.4:3000". */
  url: string;
  /** Epoch milliseconds the node first connected over this address. */
  at: number;
}

declare module "../settings" {
  interface SettingValues {
    /** By node id; nodes that were removed are dropped on the next write. */
    nodeDialedUrls: Record<string, StoredDialedUrl>;
  }
}

export function readDialedUrls(db: PanelDb): Record<string, StoredDialedUrl> {
  return getSetting(db, "nodeDialedUrls") ?? {};
}

/** Stores the node's address; writes only when it changed. */
export function recordDialedUrl(db: PanelDb, nodeId: string, url: string, now = Date.now()): void {
  const stored = readDialedUrls(db);
  if (stored[nodeId]?.url === url) return;
  const known = new Set(
    db
      .select({ id: nodes.id })
      .from(nodes)
      .all()
      .map((row) => row.id),
  );
  const next: Record<string, StoredDialedUrl> = {};
  for (const [id, entry] of Object.entries(stored)) if (known.has(id)) next[id] = entry;
  next[nodeId] = { url, at: now };
  setSetting(db, "nodeDialedUrls", next);
}

/** The address the node dials: its current session's, else the last one stored; null when never seen. */
export function dialedUrlOf(deps: Pick<Deps, "db" | "agents">, nodeId: string, stored = readDialedUrls(deps.db)): string | null {
  return deps.agents.dialedAddress(nodeId) ?? stored[nodeId]?.url ?? null;
}

export interface DialingNode {
  id: string;
  name: string;
  online: boolean;
  /** null when the node never connected since the panel started recording (0.2.1). */
  url: string | null;
}

/** Every enabled node except the panel node (whose agent dials loopback), with the address it dials. */
export function dialingNodes(deps: Pick<Deps, "db" | "agents">): DialingNode[] {
  const stored = readDialedUrls(deps.db);
  return deps.db
    .select({ id: nodes.id, name: nodes.name, isPanelNode: nodes.isPanelNode })
    .from(nodes)
    .where(isNull(nodes.disabledAt))
    .all()
    .filter((row) => !row.isPanelNode)
    .map((row) => ({ id: row.id, name: row.name, online: deps.agents.isOnline(row.id), url: dialedUrlOf(deps, row.id, stored) }));
}

/** True when `url` is https://<domain> (port 443 or none). */
export function dialsDomain(url: string | null, domain: string | null): boolean {
  if (!url || !domain) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === domain.toLowerCase() && (parsed.port === "" || parsed.port === "443");
  } catch {
    return false;
  }
}

/** True for a plain http:// address. */
export function dialsPlainHttp(url: string | null): boolean {
  return url?.toLowerCase().startsWith("http://") ?? false;
}

/** Records every session's address as it starts. Call once from a module's start(). */
export function watchDialedUrls(deps: Pick<Deps, "db" | "agents" | "logger">): () => void {
  return deps.agents.onConnection((nodeId, online) => {
    if (!online) return;
    const url = deps.agents.dialedAddress(nodeId);
    if (!url) return;
    try {
      // A node removed while it was connecting has no row: nothing to keep.
      if (!deps.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)).get()) return;
      recordDialedUrl(deps.db, nodeId, url);
    } catch (error) {
      deps.logger.error({ err: error, nodeId }, "recording the address a node dials failed");
    }
  });
}
