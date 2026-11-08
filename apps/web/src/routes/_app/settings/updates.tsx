// Settings > Updates: the one auto-update switch for the panel and every
// node, the release channel (owner only), the versions running now and the
// one on offer, a manual "update now", and past runs with what became of
// nodes that were offline during one.

import { type OpOutput, updates } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { DataTable, type DataTableColumn } from "@seylo/ui/components/data-table";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Progress } from "@seylo/ui/components/progress";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { Switch } from "@seylo/ui/components/switch";
import { Tip } from "@seylo/ui/components/tooltip";
import { IconHistory, IconRefresh } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { formatDateTime, formatRelative } from "../../../components/settings/format";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { OpErrorCallout, QueryView } from "../../../components/settings/op-state";
import { SettingRow, SettingsPage } from "../../../components/settings/page";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/updates")({
  component: UpdatesPage,
});

type Status = OpOutput<typeof updates.status>;
type Run = OpOutput<typeof updates.history>["runs"][number];
type Step = Run["steps"][number];
type Channel = Status["channel"];

const channels: Channel[] = ["stable", "prerelease"];

function UpdatesPage() {
  const status = useOp(updates.status, {}, { refetchInterval: (q) => (q.state.data?.activeRun ? 3000 : false) });
  return (
    <SettingsPage title={t("settings.updates.title")} subtitle={t("settings.updates.subtitle")}>
      <QueryView query={status}>{(data) => <StatusSections data={data} />}</QueryView>
      <History />
    </SettingsPage>
  );
}

const refreshes = [updates.status, updates.history];

function StatusSections({ data }: { data: Status }) {
  const [confirmPanel, setConfirmPanel] = useState(false);
  const [confirmPrerelease, setConfirmPrerelease] = useState(false);
  const setAuto = useSettingsMutation(updates.setAutoUpdate, { invalidates: refreshes });
  const setChannel = useSettingsMutation(updates.setChannel, {
    invalidates: refreshes,
    success: (out) => t(`settings.updates.channelSaved.${out.channel}`),
  });
  const offered = data.panel.offeredVersion;
  const check = useSettingsMutation(updates.check, {
    invalidates: refreshes,
    success: (out) =>
      out.panel.updateAvailable ? t("settings.updates.found", { version: out.panel.latestVersion ?? "" }) : t("settings.updates.upToDate"),
  });
  const updatePanel = useSettingsMutation(updates.updatePanel, { invalidates: refreshes, success: t("settings.updates.started") });
  const updateNode = useSettingsMutation(updates.updateNode, { invalidates: refreshes, success: t("settings.updates.started") });
  const run = data.activeRun;

  return (
    <>
      <SectionCard>
        <SettingRow
          title={t("settings.updates.autoTitle")}
          description={t("settings.updates.autoDescription")}
          control={
            <Switch
              checked={data.autoUpdate}
              disabled={setAuto.isPending}
              aria-label={t("settings.updates.autoTitle")}
              onCheckedChange={(enabled) => setAuto.mutate({ enabled })}
            />
          }
        />
        <SettingRow
          title={t("settings.updates.channelTitle")}
          description={
            data.canChangeChannel
              ? t(`settings.updates.channelDescription.${data.channel}`)
              : `${t(`settings.updates.channelDescription.${data.channel}`)} ${t("settings.updates.channelOwnerOnly")}`
          }
          control={
            <Segmented
              aria-label={t("settings.updates.channelTitle")}
              value={data.channel}
              onValueChange={(next) => {
                const channel = next as Channel;
                if (channel === data.channel) return;
                if (channel === "prerelease") setConfirmPrerelease(true);
                else setChannel.mutate({ channel });
              }}
            >
              {channels.map((channel) => (
                <SegmentedItem
                  key={channel}
                  value={channel}
                  className="px-3 duration-200 disabled:cursor-default"
                  disabled={!data.canChangeChannel || setChannel.isPending}
                >
                  {t(`settings.updates.channels.${channel}`)}
                </SegmentedItem>
              ))}
            </Segmented>
          }
        />
      </SectionCard>

      {run && (
        <Alert
          tone="info"
          title={t("settings.updates.running", { version: run.targetVersion, done: run.doneSteps, total: run.totalSteps })}
        >
          <Progress value={run.totalSteps ? (run.doneSteps / run.totalSteps) * 100 : null} className="mt-2" />
        </Alert>
      )}

      <SectionCard
        title={t("settings.updates.panelTitle")}
        actions={
          <>
            <Button size="sm" onClick={() => check.mutate({})} disabled={check.isPending}>
              <IconRefresh size={15} stroke={1.8} />
              {check.isPending ? t("settings.updates.checking") : t("settings.updates.check")}
            </Button>
            {offered && (
              <Button size="sm" variant="primary" disabled={!!run || updatePanel.isPending} onClick={() => setConfirmPanel(true)}>
                {t("settings.updates.updateTo", { version: offered })}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
          <span>
            <span className="text-muted-foreground">{t("settings.updates.current")} </span>
            <span className="font-mono">{data.panel.currentVersion}</span>
          </span>
          <span>
            <span className="text-muted-foreground">{t(`settings.updates.newest.${data.channel}`)} </span>
            <span className="font-mono">{data.panel.latestVersion ?? "-"}</span>
          </span>
          {data.panel.latestIsPrerelease && <Chip tone="amber">{t("settings.updates.prereleaseChip")}</Chip>}
          {offered ? (
            <Chip tone="blue">{t("settings.updates.offered", { version: offered })}</Chip>
          ) : (
            data.panel.latestVersion && <Chip tone="green">{t("settings.updates.upToDate")}</Chip>
          )}
          {data.panel.changelogUrl && (
            <a href={data.panel.changelogUrl} target="_blank" rel="noreferrer" className="text-link hover:text-link-hover">
              {t("settings.updates.changelog")}
            </a>
          )}
        </div>
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {data.lastCheckedAt
            ? t("settings.updates.lastChecked", { when: formatRelative(data.lastCheckedAt) })
            : t("settings.updates.neverChecked")}
          {data.channel === "stable" && !offered && isPrerelease(data.panel.currentVersion) && (
            <> {t("settings.updates.keepsPrerelease", { version: data.panel.currentVersion })}</>
          )}
        </p>
        {data.checkError && (
          <Alert tone="warning" title={t("settings.updates.checkFailed")}>
            {data.checkError}
          </Alert>
        )}
      </SectionCard>

      <SectionCard title={t("settings.updates.nodesTitle")} description={t("settings.updates.nodesDescription")} flush>
        <DataTable
          bare
          aria-label={t("settings.updates.nodesTitle")}
          rows={data.nodes}
          getRowId={(row) => row.nodeId}
          empty={<EmptyState compact title={t("settings.updates.noNodes")} />}
          columns={[
            {
              id: "name",
              header: t("settings.updates.node"),
              cell: (row) => (
                <span className="flex items-center gap-2">
                  <StatusDot status={row.online ? "ok" : "off"} />
                  <span className="font-medium">{row.name}</span>
                </span>
              ),
              sortValue: (row) => row.name,
            },
            {
              id: "version",
              header: t("settings.updates.version"),
              cell: (row) => <span className="font-mono text-[12.5px]">{row.version ?? "-"}</span>,
            },
            {
              id: "state",
              header: t("settings.updates.state"),
              cell: (row) =>
                !row.online ? (
                  <Chip tone="gray">{t("settings.updates.offline")}</Chip>
                ) : row.updateAvailable ? (
                  <Chip tone="blue">{t("settings.updates.available")}</Chip>
                ) : (
                  <Chip tone="green">{t("settings.updates.upToDate")}</Chip>
                ),
            },
            {
              id: "action",
              header: "",
              align: "right",
              cell: (row) =>
                row.updateAvailable && (
                  <Button
                    size="sm"
                    disabled={!row.online || !!run || updateNode.isPending}
                    onClick={() => updateNode.mutate({ nodeId: row.nodeId })}
                  >
                    {t("settings.updates.updateNow")}
                  </Button>
                ),
            },
          ]}
        />
      </SectionCard>

      <ConfirmDialog
        open={confirmPanel}
        onOpenChange={setConfirmPanel}
        title={t("settings.updates.confirmTitle", { version: offered ?? "" })}
        description={t("settings.updates.confirmDescription")}
        confirmLabel={t("settings.updates.updateNow")}
        onConfirm={() => updatePanel.mutateAsync({ panelOnly: false }).then(() => undefined)}
      />
      <ConfirmDialog
        open={confirmPrerelease}
        onOpenChange={setConfirmPrerelease}
        title={t("settings.updates.prereleaseConfirmTitle")}
        description={t("settings.updates.prereleaseConfirmDescription")}
        confirmLabel={t("settings.updates.prereleaseConfirm")}
        onConfirm={() => setChannel.mutateAsync({ channel: "prerelease" }).then(() => undefined)}
      />
    </>
  );
}

/** A version with a pre-release part, such as 0.2.0-rc.2. */
function isPrerelease(version: string): boolean {
  return /^v?\d+\.\d+\.\d+-/.test(version);
}

const stepTone = (step: Step) =>
  step.retry === "waiting"
    ? "amber"
    : step.status === "failed" || step.status === "rolledBack"
      ? "red"
      : step.status === "succeeded"
        ? "green"
        : "gray";

/** What a step's chip says on hover: its outcome, the error, and what became of an offline node. */
function stepDetail(step: Step): string {
  const lines = [t(`settings.updates.stepStatus.${step.status}`)];
  if (step.retry === "waiting" && step.retryAt) {
    // A catch-up the agent asked to wait (its error says why): the panel tries again then.
    if (step.error) lines.push(step.error);
    lines.push(t("settings.updates.retry.waitingUntil", { version: step.toVersion, when: formatDateTime(step.retryAt) }));
  } else if (step.retry) {
    const when = step.retryAt ? formatDateTime(step.retryAt) : "";
    lines.push(t("settings.updates.wasOffline"), t(`settings.updates.retry.${step.retry}`, { version: step.toVersion, when }));
  } else if (step.error) {
    lines.push(step.error);
  }
  return lines.join(" ");
}

const runTones = { running: "blue", succeeded: "green", failed: "red", cancelled: "gray" } as const;

function History() {
  const [before, setBefore] = useState<string[]>([]);
  const cursor = before.at(-1);
  const query = useOp(updates.history, cursor ? { limit: 20, before: cursor } : { limit: 20 });
  const columns: DataTableColumn<Run>[] = [
    // Placeholder widths: what the columns get with typical runs; the steps column takes the rest.
    { id: "when", header: t("settings.updates.when"), skeletonWidth: "28%", cell: (run) => formatDateTime(run.createdAt) },
    {
      id: "version",
      header: t("settings.updates.version"),
      skeletonWidth: "10.5%",
      cell: (run) => <span className="font-mono text-[12.5px]">{run.targetVersion}</span>,
    },
    {
      id: "trigger",
      header: t("settings.updates.trigger"),
      skeletonWidth: "16%",
      cell: (run) => t(`settings.updates.triggers.${run.trigger}`),
      hideOnMobile: true,
    },
    {
      id: "steps",
      header: t("settings.updates.steps"),
      cell: (run) => (
        <span className="flex flex-wrap gap-1">
          {run.steps.map((step) => (
            <Tip key={step.id} content={stepDetail(step)}>
              <Chip tone={stepTone(step)} tabIndex={0} aria-label={`${step.nodeName ?? t("settings.updates.panel")}: ${stepDetail(step)}`}>
                {step.target === "panel" ? t("settings.updates.panel") : (step.nodeName ?? step.target)}
              </Chip>
            </Tip>
          ))}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      id: "status",
      header: t("settings.updates.state"),
      align: "right",
      skeletonWidth: "12%",
      cell: (run) => <Chip tone={runTones[run.status]}>{t(`settings.updates.runStatus.${run.status}`)}</Chip>,
    },
  ];
  return (
    <SectionCard title={t("settings.updates.historyTitle")} flush>
      {query.error ? (
        <div className="px-5 pb-5">
          <OpErrorCallout error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : (
        <DataTable
          bare
          aria-label={t("settings.updates.historyTitle")}
          loading={query.isPending}
          rows={query.data?.runs ?? []}
          getRowId={(run) => run.id}
          columns={columns}
          empty={<EmptyState compact icon={<IconHistory />} title={t("settings.updates.noHistory")} />}
        />
      )}
      {(query.data?.hasMore || before.length > 0) && (
        <div className="flex justify-end gap-2 px-5 pb-4">
          <Button size="sm" disabled={before.length === 0} onClick={() => setBefore(before.slice(0, -1))}>
            {t("settings.newer")}
          </Button>
          <Button
            size="sm"
            disabled={!query.data?.hasMore}
            onClick={() => {
              const last = query.data?.runs.at(-1);
              if (last) setBefore([...before, last.createdAt]);
            }}
          >
            {t("settings.older")}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
