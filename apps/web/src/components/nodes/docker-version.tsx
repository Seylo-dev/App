// The node's Docker version on the Machine card and its "Update Docker"
// button, from the node's docker: the agent's own look for a newer Docker
// Engine (about daily, node.docker-check.v1), or what the last Update
// Docker dry run found. A newer version turns the version amber with a
// question mark that says which; nothing newer turns the button off. Nodes
// without docker (older agents, not checked yet) look as they always did.

import { Button } from "@seylo/ui/components/button";
import { Tip } from "@seylo/ui/components/tooltip";
import { cn } from "@seylo/ui/lib/utils";
import { IconHelpCircle, IconRefresh } from "@tabler/icons-react";
import { t } from "../../i18n/t";
import { formatAgo } from "../../lib/format";
import type { NodeRow } from "../../lib/types";

type NodeDocker = NonNullable<NodeRow["docker"]>;

/** What the question mark next to the version says; null shows none. */
export function dockerVersionTip(docker: NodeDocker | undefined): string | null {
  if (docker?.updateAvailable && docker.latest) return t("nodes.dockerAvailable", { latest: docker.latest });
  // Docker the agent cannot update (static binaries, snap): why.
  return docker?.reason ?? null;
}

/** Why "Update Docker" is off: nothing newer, or the agent cannot update Docker here. Null leaves it on. */
export function dockerUpdateBlocked(docker: NodeDocker | undefined, now = Date.now()): string | null {
  if (docker?.updateAvailable === false) {
    return t("nodes.dockerUpToDate", { version: docker.version, ago: formatAgo(docker.checkedAt, now) });
  }
  return docker?.reason ?? null;
}

/** The Docker version as the Machine card shows it. */
export function DockerVersion({ version, docker }: { version: string; docker?: NodeDocker }) {
  const tip = dockerVersionTip(docker);
  if (!tip) return <>{version}</>;
  const available = docker?.updateAvailable === true;
  return (
    <span
      data-docker-update={available ? "available" : undefined}
      className={cn("inline-flex items-center gap-1", available && "text-chip-amber-fg")}
    >
      {version}
      <Tip content={tip}>
        <button
          type="button"
          aria-label={tip}
          className={cn(
            "inline-flex size-4 cursor-help items-center justify-center rounded-full border-0 bg-transparent p-0",
            available ? "text-chip-amber-fg" : "text-ink-faint",
          )}
        >
          <IconHelpCircle size={14} stroke={2} aria-hidden="true" />
        </button>
      </Tip>
    </span>
  );
}

/** "Update Docker": off while the node is offline, a dry run runs, or there is nothing to update. */
export function DockerUpdateButton({ node, pending, onClick }: { node: NodeRow; pending: boolean; onClick: () => void }) {
  const blocked = dockerUpdateBlocked(node.docker);
  return (
    <Button size="sm" disabled={node.status !== "online" || pending || blocked !== null} title={blocked ?? undefined} onClick={onClick}>
      <IconRefresh size={15} aria-hidden="true" />
      {t("nodes.updateDocker")}
    </Button>
  );
}
