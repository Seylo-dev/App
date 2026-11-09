// The update strip on the Nodes page (Nodes.dc.html): the one auto-update
// switch for the panel and all nodes, the rollout in progress, and the
// panel's own update when one is available.

import { updates } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { ButtonSkeleton, LoadingRegion, Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { isNotBuilt } from "../query-error";

export function UpdatesBanner() {
  const status = useOp(updates.status, {});
  const setAuto = useOpMutation(updates.setAutoUpdate, {
    onSuccess: () => void status.refetch(),
    onError: (error) => toast.error(t("nodes.updates.saveFailed"), { description: errorMessage(error, t("common.unknownError")) }),
  });
  const check = useOpMutation(updates.check, {
    onSuccess: () => void status.refetch(),
    onError: (error) => toast.error(errorMessage(error, t("common.unknownError"))),
  });
  const updatePanel = useOpMutation(updates.updatePanel, {
    onSuccess: () => {
      toast.info(t("nodes.updates.started"));
      void status.refetch();
    },
    onError: (error) => toast.error(errorMessage(error, t("common.unknownError"))),
  });
  const data = status.data;
  const run = data?.activeRun ?? null;

  return (
    // Two columns: the switch with its hint on the left, the status and buttons on the right, centered.
    // Narrow, the right side wraps under the left one, from the left edge.
    <section
      aria-label={t("nodes.updates.title")}
      className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-card px-[18px] py-4"
      style={{ background: "var(--highlight)" }}
    >
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
        <label htmlFor="auto-update" className="flex cursor-pointer items-center gap-2.5 text-[13.5px] font-semibold">
          <Checkbox
            id="auto-update"
            checked={data?.autoUpdate ?? false}
            disabled={!data || setAuto.isPending}
            onCheckedChange={(value) => setAuto.mutate({ enabled: value === true })}
          />
          {t("nodes.updates.autoUpdate")}
        </label>
        {/* Under the checkbox's label, its width capped so the strip is as tall loading as loaded. */}
        <span className="max-w-[600px] pl-[26px] text-[12.5px] text-pretty text-ink-strong">{t("nodes.updates.hint")}</span>
      </div>
      {status.isPending ? (
        // The status chip and the buttons while the status loads, at their loaded size, so the strip
        // wraps the same way and the node table under it stays put.
        <LoadingRegion label={t("common.loading")} className="flex flex-wrap items-center gap-2.5">
          <Skeleton className="h-[22px] w-40 rounded-chip" />
          <ButtonSkeleton size="sm" className="w-[84px]" />
          <ButtonSkeleton size="sm" className="w-[86px]" />
        </LoadingRegion>
      ) : (
        <span className="flex flex-wrap items-center gap-2.5 text-[12.5px]">
          {status.isError && (
            <span className="text-muted-foreground">
              {isNotBuilt(status.error) ? t("nodes.updates.notBuilt") : errorMessage(status.error, t("common.unknownError"))}
            </span>
          )}
          {data?.checkError && <Chip tone="red">{data.checkError}</Chip>}
          {run ? (
            <Chip tone="amber">
              <StatusDot status="busy" pulse />
              {t("nodes.updates.rollingOut", { version: run.targetVersion, done: run.doneSteps, total: run.totalSteps })}
            </Chip>
          ) : data?.panel.updateAvailable && data.panel.latestVersion ? (
            <Button size="sm" variant="primary" disabled={updatePanel.isPending} onClick={() => updatePanel.mutate({})}>
              {t("nodes.updates.updateTo", { version: data.panel.latestVersion })}
            </Button>
          ) : (
            data && (
              <Chip tone="green">
                <StatusDot status="ok" />
                {t("nodes.updates.upToDate", { version: data.panel.currentVersion })}
              </Chip>
            )
          )}
          {data && !run && (
            <Button size="sm" disabled={check.isPending} onClick={() => check.mutate({})}>
              {t("nodes.updates.checkNow")}
            </Button>
          )}
          {data?.panel.changelogUrl && (
            <Button size="sm" asChild>
              <a href={data.panel.changelogUrl} target="_blank" rel="noreferrer">
                {t("nodes.updates.changelog")}
              </a>
            </Button>
          )}
        </span>
      )}
    </section>
  );
}
