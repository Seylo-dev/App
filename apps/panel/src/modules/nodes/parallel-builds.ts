// "Builds at once" of a node: its fixed number, or on Auto what
// autoParallelBuilds (@seylo/ops) works out from its cores and memory. The
// desired-state compiler sends it as NodeSettings.max_parallel_builds from
// the facts stored in nodes.facts (written at every hello before the
// connect sync, and within factsWriteMs of a NodeFacts event, which then
// resends the settings when the number changed: index.ts), and the nodes
// view returns it as maxParallelBuilds.

import { fromJson } from "@bufbuild/protobuf";
import { autoParallelBuilds, type ParallelBuildsFacts } from "@seylo/ops";
import { type NodeFacts, NodeFactsSchema } from "@seylo/proto";
import type { nodes } from "../../db/schema";

type NodeRow = typeof nodes.$inferSelect;

/** The NodeFacts kept in nodes.facts (protobuf JSON); null when there are none or they do not parse. */
export function storedFacts(json: NodeRow["facts"]): NodeFacts | null {
  if (!json) return null;
  try {
    return fromJson(NodeFactsSchema, json as never, { ignoreUnknownFields: true });
  } catch {
    return null;
  }
}

/** The builds at once that apply on the node now, whether or not it can build (the compiler sends 0 then). */
export function parallelBuildsOf(
  row: Pick<NodeRow, "parallelBuildsAuto" | "maxParallelBuilds">,
  facts: ParallelBuildsFacts | null,
): number {
  return row.parallelBuildsAuto ? autoParallelBuilds(facts) : row.maxParallelBuilds;
}
