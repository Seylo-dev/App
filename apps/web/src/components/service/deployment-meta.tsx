// Shared words and chips about one deployment: what triggered it, where it
// was built and shipped, how long it took, the image digest.

import type { deployments } from "@seylo/ops";
import {
  type Icon,
  IconApi,
  IconArrowBackUp,
  IconArrowsRightLeft,
  IconClock,
  IconCube,
  IconGitCommit,
  IconGitPullRequest,
  IconPackage,
  IconServer2,
  IconTemplate,
  IconUser,
  IconWebhook,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import type { Deployment } from "./deploy-steps";
import { formatBytes, formatDuration, shortDigest, shortSha } from "./format";

type Trigger = (typeof deployments.DeploymentTrigger)["static"];

export const triggerIcons: Record<Trigger, Icon> = {
  manual: IconUser,
  push: IconGitCommit,
  rollback: IconArrowBackUp,
  api: IconApi,
  preview: IconGitPullRequest,
  template: IconTemplate,
  webhook: IconWebhook,
  move: IconArrowsRightLeft,
};

export function triggerLabel(trigger: Trigger): string {
  return t(`serviceDeploys.trigger.${trigger}`);
}

/** Bold title of a row: the commit message, else a sentence for image deploys, rollbacks and moves. */
export function deploymentTitle(d: Deployment): string {
  if (d.commit?.message) return d.commit.message.split("\n")[0] ?? "";
  if (d.trigger === "rollback") return t("serviceDeploys.title.rollback");
  if (d.trigger === "move") return t("serviceDeploys.title.move");
  if (d.image) return t("serviceDeploys.title.image", { image: d.image.reference });
  return t("serviceDeploys.title.generation", { generation: d.generation });
}

/** The short version shown next to the title: commit, or the image digest. */
export function deploymentVersion(d: Deployment): string {
  if (d.commit) return shortSha(d.commit.sha);
  return shortDigest(d.image?.digest);
}

/** Total time of a finished deploy, or the time so far for a running one. */
export function deploymentDurationMs(d: Deployment, now: number): number | null {
  if (d.durationMs != null) return d.durationMs;
  const from = d.startedAt ?? d.createdAt;
  return d.finishedAt ? Date.parse(d.finishedAt) - Date.parse(from) : now - Date.parse(from);
}

export function healthFailed(d: Deployment): boolean {
  return d.status === "failed" && d.steps.some((s) => s.key === "health" && s.status === "failed");
}

export function MetaChip({ icon: Icon, children, title }: { icon: Icon; children: ReactNode; title?: string }) {
  return (
    <span title={title} className="flex items-center gap-[5px] rounded-chip bg-muted px-2 py-[3px]">
      <Icon size={12} stroke={2.2} className="text-muted-foreground" aria-hidden="true" />
      {children}
    </span>
  );
}

/** Built on, shipped, digest, took, trigger: the chips of a history row. */
export function DeploymentChips({ d, now }: { d: Deployment; now: number }) {
  const Trigger = triggerIcons[d.trigger];
  const took = deploymentDurationMs(d, now);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-ink-strong">
      {d.builtOn ? (
        <MetaChip icon={IconServer2}>{t("serviceDeploys.chips.builtOn", { node: d.builtOn.name })}</MetaChip>
      ) : (
        d.image && <MetaChip icon={IconServer2}>{t("serviceDeploys.chips.notBuilt")}</MetaChip>
      )}
      {d.image?.shippedBytes != null && (
        <MetaChip icon={IconPackage} title={d.shippedTo.map((n) => n.name).join(", ")}>
          {t("serviceDeploys.chips.shipped", { size: formatBytes(d.image.shippedBytes) })}
        </MetaChip>
      )}
      {d.image?.digest && (
        <MetaChip icon={IconCube} title={d.image.digest}>
          <span className="font-mono">{shortDigest(d.image.digest)}</span>
        </MetaChip>
      )}
      {took != null && d.status !== "queued" && (
        <MetaChip icon={IconClock} title={t("serviceDeploys.chips.tookTitle")}>
          {formatDuration(took)}
        </MetaChip>
      )}
      <MetaChip icon={Trigger}>
        {d.actor ? t("serviceDeploys.chips.triggerBy", { trigger: triggerLabel(d.trigger), actor: d.actor }) : triggerLabel(d.trigger)}
      </MetaChip>
    </div>
  );
}
