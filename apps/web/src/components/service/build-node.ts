// Which node builds a service, as the build node picker and the Deployments
// page say it. Both follow the panel's pickBuildNode
// (apps/panel/src/modules/deployments/source.ts): the build node from the
// build settings, else the service's own node when it can build, else the
// least busy node that can. A node can build when Can build is on, it is
// online and its agent has docker buildx.

import type { builds, OpOutput } from "@seylo/ops";
import { t } from "../../i18n/t";

type Settings = OpOutput<typeof builds.getSettings>;
type BuildNode = Settings["nodes"][number];

/** Why the panel would not pick this node for a build now, as a short note; null when it would. */
export function cantBuildNote(node: BuildNode): string | null {
  if (!node.canBuild) return t("serviceSource.build.cantBuild");
  if (!node.online) return t("serviceSource.build.offline");
  if (!node.hasBuildx) return t("serviceSource.build.noBuildx");
  return null;
}

const usable = (node: BuildNode) => cantBuildNote(node) === null;

/** The "Builds on" fact of the Deployments page; null for services that are not built. */
export function buildNodeText(
  data: Settings | undefined,
  service: { source: { type: string }; placements: readonly { nodeId: string }[] },
): string | null {
  if (!data || service.source.type === "image" || service.source.type === "none") return null;
  const chosen = data.settings.buildNodeId ? data.nodes.find((n) => n.id === data.settings.buildNodeId) : undefined;
  if (chosen) {
    // pickBuildNode refuses it, and the deploy stops with the same words.
    if (!chosen.hasBuildx) return t("serviceDeploys.facts.chosenNoBuildx", { node: chosen.name });
    return t("serviceDeploys.facts.buildsOn", { node: chosen.name });
  }
  const placed = service.placements.flatMap((p) => data.nodes.filter((n) => n.id === p.nodeId));
  const own = placed.find(usable);
  if (own) return t("serviceDeploys.facts.buildsOn", { node: own.name });
  const builder = data.nodes.filter(usable).sort((a, b) => a.queued - b.queued || a.name.localeCompare(b.name))[0];
  if (!builder) return t("serviceDeploys.facts.noBuilder");
  const target = placed[0];
  if (!target) return t("serviceDeploys.facts.buildsOn", { node: builder.name });
  if (!target.canBuild) return t("serviceDeploys.facts.buildsOnInstead", { node: builder.name, target: target.name });
  if (!target.online) return t("serviceDeploys.facts.buildsOnOffline", { node: builder.name, target: target.name });
  return t("serviceDeploys.facts.buildsOnNoBuildx", { node: builder.name, target: target.name });
}
