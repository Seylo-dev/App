// Which nodes a service runs on compared to another one. There is no
// cross-node private network, so internal addresses only work between
// services that share every node.

import type { NodeRef } from "./types";

/** Nodes of self that the target has no instance on. Shared targets and unplaced services never miss. */
export function missingNodes(self: readonly NodeRef[], target: readonly NodeRef[]): NodeRef[] {
  if (target.length === 0) return [];
  const have = new Set(target.map((n) => n.id));
  return self.filter((n) => !have.has(n.id));
}
