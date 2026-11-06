// The node summary at the bottom of the sidebar: how many nodes are online,
// whether auto-update is on, and the update state (up to date, update
// available, or a rollout in progress with its progress bar).

import { updates } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { StatusDot } from "@seylo/ui/components/chip";
import { Link } from "@tanstack/react-router";
import { t } from "../../i18n/t";

export function NodesCard({ online, total }: { online: number | undefined; total: number | undefined }) {
  const status = useOp(updates.status, {});
  const run = status.data?.activeRun ?? null;
  const share = run ? progressOf(run.doneSteps, run.totalSteps) : progressOf(online ?? 0, total ?? 0);

  let autoUpdate = t("common.notAvailableYet");
  let state = "";
  if (status.data) {
    autoUpdate = t(status.data.autoUpdate ? "sidebar.autoUpdateOn" : "sidebar.autoUpdateOff");
    const behind = status.data.panel.updateAvailable || status.data.nodes.some((node) => node.updateAvailable);
    state = run
      ? t("sidebar.rollingOut", { done: run.doneSteps, total: run.totalSteps })
      : t(behind ? "sidebar.updateAvailable" : "sidebar.upToDate");
  }

  return (
    <Link
      to="/nodes"
      aria-label={t("sidebar.nodesCard")}
      className="flex flex-col gap-[7px] rounded-card p-3.5 text-foreground hover:text-foreground"
      style={{ background: "var(--highlight)" }}
    >
      <span className="flex items-center gap-[7px] text-[13.5px] font-semibold">
        <StatusDot status={online ? "ok" : "off"} className="size-[7px]" />
        {t("sidebar.nodesOnline", { count: online ?? 0 })}
      </span>
      <span className="flex justify-between gap-2 text-xs text-ink-strong">
        <span>{autoUpdate}</span>
        <span>{state}</span>
      </span>
      <span className="h-1 rounded-sm bg-card" aria-hidden="true">
        <span className="block h-1 rounded-sm bg-primary transition-[width]" style={{ width: `${share}%` }} />
      </span>
    </Link>
  );
}

function progressOf(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}
