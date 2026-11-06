// Docker cleanup on a node. Only resources this panel created (labeled
// seylo.managed=true) are ever touched; whole-machine cleanup is
// deliberately not offered.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id } from "../schemas";

const PruneInput = Type.Object({
  nodeId: Id,
  /** Images no service generation needs any more (rollback images are kept). */
  images: Type.Optional(Type.Boolean({ default: true })),
  buildCache: Type.Optional(Type.Boolean({ default: true })),
  stoppedContainers: Type.Optional(Type.Boolean({ default: true })),
  /** Data folders of services removed without deleting their data. */
  orphanedServiceData: Type.Optional(Type.Boolean({ default: false })),
});

const PruneResult = Type.Object({
  nodeId: Id,
  /** Reclaimed by a run, or reclaimable for a preview. */
  bytes: Type.Integer({ minimum: 0 }),
  /** Human-readable lines, one per removed (or removable) thing. */
  items: Type.Array(Type.String()),
});

export const preview = defineOp({
  id: "cleanup.preview",
  kind: "query",
  summary: "Preview a cleanup",
  description: "Lists what a cleanup of this node would remove and how much space it frees, without removing anything.",
  input: PruneInput,
  output: PruneResult,
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: false,
});

export const run = defineOp({
  id: "cleanup.run",
  kind: "destructive",
  summary: "Clean up a node",
  description:
    "Removes unused images, build cache, stopped containers and (when asked) orphaned service data created by this panel on one node. Never touches anything else on the machine.",
  input: PruneInput,
  output: PruneResult,
  permission: permission.global("nodes.manage"),
  mcp: true,
  audit: true,
});
