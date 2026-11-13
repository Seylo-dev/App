// Which node builds a service, as the build node picker and the Deployments
// page say it. Both follow the panel's pickBuildNode
// (apps/panel/src/modules/deployments/source.ts): the build node from the
// build settings, else the service's own node when it can build, else the
// node that can with the most free build slots (Builds at once minus its
// builds in flight), then the fewest builds in flight, then by name. A
// node can build when Can build is on, it is online and its agent has
// docker buildx.

import type { builds, OpOutput } from "@seylo/ops";
import { t } from "../../i18n/t";

type Settings = OpOutput<typeof builds.getSettings>;
type BuildNode = Settings["nodes"][number];

/** Why the panel would not pick this node for a build now, as a short note; null when it would. */
export function cantBuildNote(node: BuildNode): string | null {
  if (!node.canBuild) return t("serviceSource.build.cantBuild");
  if (!node.online) return t("serviceSource.build.offline");
  // An older fixture or agent without the field counts as having it, as in the panel.
  if (node.hasBuildx === false) return t("serviceSource.build.noBuildx");
  return null;
}

const usable = (node: BuildNode) => cantBuildNote(node) === null;

/**
 * Free build slots, as pickBuildNode counts them: below 0 when builds wait
 * there. A panel answer without buildsAtOnce (before 0.2.15) counts 0, so
 * the order falls back to the fewest builds in flight.
 */
function freeSlots(node: Pick<BuildNode, "queued"> & { buildsAtOnce?: number }): number {
  return (node.buildsAtOnce ?? 0) - node.queued;
}

/** The automatic pick's order: most free slots, then fewest builds in flight, then by name. */
function byFreeSlots(a: BuildNode, b: BuildNode): number {
  return freeSlots(b) - freeSlots(a) || a.queued - b.queued || a.name.localeCompare(b.name);
}

/**
 * The node's builds in flight for the picker: "2 running, 1 waiting" (waiting
 * for a free slot of its Builds at once); null with none. A fixture without
 * running and waiting says "3 builds queued" as before.
 */
export function buildLoadNote(node: Pick<BuildNode, "queued"> & { running?: number; waiting?: number }): string | null {
  if (node.queued === 0) return null;
  if (node.running === undefined || node.waiting === undefined) return t("serviceSource.build.queued", { count: node.queued });
  const parts: string[] = [];
  if (node.running > 0) parts.push(t("serviceSource.build.running", { count: node.running }));
  if (node.waiting > 0) parts.push(t("serviceSource.build.waiting", { count: node.waiting }));
  return parts.join(", ");
}

/** The "Builds on" fact of the Deployments page; null for services that are not built. */
export function buildNodeText(
  data: Settings | undefined,
  service: { source: { type: string }; placements: readonly { nodeId: string }[] },
): string | null {
  if (!data || service.source.type === "image" || service.source.type === "none") return null;
  const chosen = data.settings.buildNodeId ? data.nodes.find((n) => n.id === data.settings.buildNodeId) : undefined;
  if (chosen) {
    // pickBuildNode refuses it, and the deploy stops with the same words.
    if (chosen.hasBuildx === false) return t("serviceDeploys.facts.chosenNoBuildx", { node: chosen.name });
    return t("serviceDeploys.facts.buildsOn", { node: chosen.name });
  }
  const placed = service.placements.flatMap((p) => data.nodes.filter((n) => n.id === p.nodeId));
  const own = placed.find(usable);
  if (own) return t("serviceDeploys.facts.buildsOn", { node: own.name });
  const builder = data.nodes.filter(usable).sort(byFreeSlots)[0];
  if (!builder) return t("serviceDeploys.facts.noBuilder");
  const target = placed[0];
  if (!target) return t("serviceDeploys.facts.buildsOn", { node: builder.name });
  if (!target.canBuild) return t("serviceDeploys.facts.buildsOnInstead", { node: builder.name, target: target.name });
  if (!target.online) return t("serviceDeploys.facts.buildsOnOffline", { node: builder.name, target: target.name });
  return t("serviceDeploys.facts.buildsOnNoBuildx", { node: builder.name, target: target.name });
}
