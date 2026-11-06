// The update strip on the Nodes page (Nodes.dc.html): the one auto-update
// switch for the panel and all nodes, the rollout in progress, and the
// panel's own update when one is available.

import { updates } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
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
    <section
      aria-label={t("nodes.updates.title")}
      className="flex flex-wrap items-center gap-3.5 rounded-card px-[18px] py-4"
      style={{ background: "var(--highlight)" }}
    >
      <label htmlFor="auto-update" className="flex items-center gap-2.5 text-[13.5px] font-semibold">
        <Checkbox
          id="auto-update"
          checked={data?.autoUpdate ?? false}
          disabled={!data || setAuto.isPending}
          onCheckedChange={(value) => setAuto.mutate({ enabled: value === true })}
        />
        {t("nodes.updates.autoUpdate")}
      </label>
      <span className="text-[12.5px] text-ink-strong">{t("nodes.updates.hint")}</span>
      <span className="ml-auto flex flex-wrap items-center gap-2.5 text-[12.5px]">
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
    </section>
  );
}
