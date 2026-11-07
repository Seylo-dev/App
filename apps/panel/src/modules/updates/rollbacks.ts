// Releases an update guard rolled back, as the panel remembers them.
//
// An agent's guard restores the previous binary when a new one does not
// reconnect in time and then reports a durable UpdateResult with
// rolled_back (and raises an UPDATE_FAILED node alert, whose text names the
// version). The agent's own automatic updates of that release back off
// (go/internal/update/rollbacks.go), but UpdateAgent installs whatever the
// panel asks for, by design, and the panel's automatic run (updates.check
// every few hours with auto-update on) is such a call. Without a record of
// its own the panel would reinstall a bad release on that node every check:
// install, three minutes, roll back, restart, each restart cancelling the
// node's builds and shells.
//
// So every rolled-back result is recorded here by node and version, also
// those of the agent's own updates (no run step names them), and automatic
// runs leave the node out for that version. A newer release is another
// version; a person starting an update of the node (Update now, or updating
// everything) clears the record and installs it; a successful update to the
// version or past it forgets it. The panel's own update (UpdatePanel on the
// panel node) is kept the same way under `panelKey`.

import { type UpdateResult, UpdateTarget } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { compareVersions, parseVersion } from "../../agent-hub/version";
import type { PanelDb } from "../../db/client";
import { nodes } from "../../db/schema";
import { deleteSetting, getSetting, setSetting } from "../../settings";

declare module "../../settings" {
  interface SettingValues {
    /** Rolled-back releases by node id (or `panelKey`), newest last. See modules/updates/rollbacks.ts. */
    updateRollbacks: Record<string, RolledBackRelease[]>;
  }
}

export interface RolledBackRelease {
  version: string;
  /** How many times it was rolled back on this node. */
  count: number;
  /** The last time, ISO 8601. */
  at: string;
}

/** The key of the panel's own update (UpdatePanel). */
export const panelKey = "panel";
/** Versions remembered per node; a node can only push out its own. */
const maxPerKey = 10;

const sameVersion = (a: string, b: string) => {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x !== null && y !== null && compareVersions(x, y) === 0;
};

/** Whether `version` was rolled back on this node (or the panel, `panelKey`) and nobody asked for it since. */
export function wasRolledBack(db: PanelDb, key: string, version: string): boolean {
  return (getSetting(db, "updateRollbacks")?.[key] ?? []).some((r) => sameVersion(r.version, version));
}

function update(db: PanelDb, key: string, change: (list: RolledBackRelease[]) => RolledBackRelease[]): void {
  const all = { ...(getSetting(db, "updateRollbacks") ?? {}) };
  const list = change(all[key] ?? []).slice(-maxPerKey);
  if (list.length > 0) all[key] = list;
  else delete all[key];
  // Nodes that were removed leave their records behind otherwise.
  const known = new Set(
    db
      .select({ id: nodes.id })
      .from(nodes)
      .all()
      .map((n) => n.id),
  );
  for (const id of Object.keys(all)) if (id !== panelKey && !known.has(id)) delete all[id];
  if (Object.keys(all).length > 0) setSetting(db, "updateRollbacks", all);
  else deleteSetting(db, "updateRollbacks");
}

/** A person started an update of this node (or the panel) to `version`: automatic runs may try it again. */
export function forgetRollback(db: PanelDb, key: string, version: string): void {
  if (!wasRolledBack(db, key, version)) return;
  update(db, key, (list) => list.filter((r) => !sameVersion(r.version, version)));
}

/**
 * Records what a durable UpdateResult says about rollbacks: a rolled-back
 * agent or panel update is remembered for its version; a successful one
 * forgets that version and every older one. `panelNodeId` is the node the
 * panel runs on; a panel result from any other node is ignored.
 */
export function noteUpdateResult(db: PanelDb, nodeId: string, result: UpdateResult, panelNodeId: string | null, now = new Date()): void {
  let key: string;
  if (result.target === UpdateTarget.AGENT) key = nodeId;
  else if (result.target === UpdateTarget.PANEL && nodeId === panelNodeId) key = panelKey;
  else return;
  const version = parseVersion(result.toVersion);
  if (!version) return;
  if (result.success) {
    const list = getSetting(db, "updateRollbacks")?.[key] ?? [];
    if (list.length === 0) return;
    update(db, key, (all) =>
      all.filter((r) => {
        const v = parseVersion(r.version);
        return v !== null && compareVersions(v, version) > 0;
      }),
    );
    return;
  }
  if (!result.rolledBack) return;
  update(db, key, (list) => {
    const previous = list.find((r) => sameVersion(r.version, result.toVersion));
    const rest = list.filter((r) => r !== previous);
    return [...rest, { version: result.toVersion.trim().slice(0, 128), count: (previous?.count ?? 0) + 1, at: now.toISOString() }];
  });
}

/** The panel node's id, if one is set. */
export function panelNodeId(db: PanelDb): string | null {
  return db.select({ id: nodes.id }).from(nodes).where(eq(nodes.isPanelNode, true)).get()?.id ?? null;
}
