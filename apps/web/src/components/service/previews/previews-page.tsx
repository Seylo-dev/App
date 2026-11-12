// The Previews tab: PR previews on/off (turning them on needs an explicit
// "same environment = same database" acknowledgement), their domain
// pattern and limit, and the list of previews with their status.

import { type OpOutput, previews } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { SectionCard, SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { ButtonSkeleton, FieldSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { IconGitPullRequest, IconTrash } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { CheckLabel, Field, parseIntOrNull, ToggleRow } from "../field";
import { formatRelative, shortSha } from "../format";
import { useInvalidate } from "../invalidate";
import { isNotBuilt, MutationError, OpErrorNote, retryOp } from "../op-state";
import { CardSaveBar } from "../save-bar";
import { RowsSkeleton } from "../service-skeletons";
import { DeploymentStatusChip } from "../status-chip";
import type { ServiceDetail } from "../use-service";

type Settings = OpOutput<typeof previews.getSettings>;
type Preview = OpOutput<typeof previews.list>["previews"][number];

export function PreviewsPage({ service }: { service: ServiceDetail }) {
  const settings = useOp(previews.getSettings, { serviceId: service.id }, { retry: retryOp });
  return (
    <div className="flex flex-col gap-4">
      {settings.isPending ? (
        <LoadingRegion label={t("common.loading")}>
          <SectionCardSkeleton
            titleWidth="w-40"
            description="w-[min(520px,100%)]"
            footer={<ButtonSkeleton size="sm" className="w-[52px]" />}
          >
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <SkeletonText className="w-20 text-[13.5px]" />
                <SkeletonText className="w-60 text-[12.5px]" />
              </div>
              <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
            </div>
            <Skeleton className="h-[67px] bg-chip-amber-bg" />
            <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <FieldSkeleton hint />
              <FieldSkeleton labelWidth="w-20" hint />
            </div>
          </SectionCardSkeleton>
        </LoadingRegion>
      ) : settings.isError ? (
        <OpErrorNote error={settings.error} />
      ) : (
        <SettingsCard key={JSON.stringify(settings.data.settings)} service={service} data={settings.data} />
      )}
      <PreviewList service={service} />
    </div>
  );
}

function SettingsCard({ service, data }: { service: ServiceDetail; data: Settings }) {
  const [pattern, setPattern] = useState(data.settings.domainPattern);
  const [max, setMax] = useState(String(data.settings.maxPreviews));
  const [ack, setAck] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const invalidate = useInvalidate();
  const update = useOpMutation(previews.updateSettings, {
    onSuccess: () => {
      invalidate(previews.getSettings, previews.list);
      toast.success(t("service.saved"));
    },
    onError: (error) => toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed"))),
  });
  const s = data.settings;

  return (
    <SectionCard title={t("servicePreviews.title")} description={t("servicePreviews.description")}>
      {!data.available ? (
        <Callout tone="neutral" title={t("servicePreviews.unavailable")}>
          {data.unavailableReason ?? t("servicePreviews.githubOnly")}{" "}
          <Link to="/p/$projectId/s/$serviceId/source" params={{ projectId: service.projectId, serviceId: service.id }}>
            {t("servicePreviews.toSource")}
          </Link>
        </Callout>
      ) : (
        <>
          <ToggleRow
            title={t("servicePreviews.enabled")}
            description={t("servicePreviews.enabledHint")}
            control={
              <Switch
                checked={s.enabled}
                disabled={update.isPending}
                onCheckedChange={(on) => (on ? setConfirm(true) : update.mutate({ serviceId: service.id, enabled: false }))}
                aria-label={t("servicePreviews.enabled")}
              />
            }
          />
          <Callout tone="warning" title={t("servicePreviews.sameEnvTitle")}>
            {t("servicePreviews.sameEnvBody")}
          </Callout>
          <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
            <Field label={t("servicePreviews.pattern")} htmlFor="pv-pattern" hint={t("servicePreviews.patternHint")}>
              <Input
                id="pv-pattern"
                className="font-mono"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="pr-{pr}-{service}.preview.example.com"
              />
            </Field>
            <Field label={t("servicePreviews.max")} htmlFor="pv-max" hint={t("servicePreviews.maxHint")}>
              <Input id="pv-max" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} />
            </Field>
          </div>
          <CardSaveBar>
            <Button
              size="sm"
              variant="primary"
              disabled={update.isPending || (pattern === s.domainPattern && max === String(s.maxPreviews))}
              onClick={() =>
                update.mutate({ serviceId: service.id, domainPattern: pattern.trim(), maxPreviews: parseIntOrNull(max) ?? s.maxPreviews })
              }
            >
              {t("service.save")}
            </Button>
            <MutationError error={update.error} />
          </CardSaveBar>
        </>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={(o) => {
          setConfirm(o);
          if (!o) setAck(false);
        }}
        title={t("servicePreviews.turnOnTitle")}
        description={t("servicePreviews.sameEnvBody")}
        confirmLabel={t("servicePreviews.turnOn")}
        onConfirm={() =>
          ack
            ? update.mutateAsync({ serviceId: service.id, enabled: true, acknowledgeSharedEnv: true }).then(() => undefined)
            : Promise.reject(new Error(t("servicePreviews.ackRequired")))
        }
      >
        <CheckLabel className="flex items-center gap-2 text-[13px]" checked={ack} onCheckedChange={(v) => setAck(v === true)}>
          {t("servicePreviews.acknowledge")}
        </CheckLabel>
      </ConfirmDialog>
    </SectionCard>
  );
}

function PreviewList({ service }: { service: ServiceDetail }) {
  const list = useOp(previews.list, { serviceId: service.id }, { retry: retryOp });
  const [removing, setRemoving] = useState<Preview | null>(null);
  const invalidate = useInvalidate();
  const remove = useOpMutation(previews.remove, { onSuccess: () => invalidate(previews.list) });
  return (
    <Card className="gap-0 overflow-hidden p-0" aria-label={t("servicePreviews.list")}>
      <div className="px-5 pt-4 pb-3.5">
        <h2 className="m-0 text-[15px] font-semibold">{t("servicePreviews.list")}</h2>
      </div>
      {list.isPending ? (
        <RowsSkeleton rows={2} lead="icon" lines={1} width="w-72" className="py-2.5" />
      ) : list.isError ? (
        <OpErrorNote error={list.error} className="mx-5 mb-4" />
      ) : list.data.previews.length === 0 ? (
        <div className="border-t border-divider">
          <EmptyState compact title={t("servicePreviews.none")} description={t("servicePreviews.noneHint")} />
        </div>
      ) : (
        list.data.previews.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-3 border-t border-divider px-5 py-3 text-[13px]">
            <IconGitPullRequest size={16} className={p.closedAt ? "text-ink-ghost" : "text-chip-green-fg"} aria-hidden="true" />
            <b className="font-semibold">#{p.prNumber}</b>
            <span className="min-w-0 truncate">{p.prTitle}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {p.branch}
              {p.commitSha ? ` · ${shortSha(p.commitSha)}` : ""}
            </span>
            {p.status && <DeploymentStatusChip status={p.status} buildWaiting={p.buildWaiting} />}
            {p.closedAt && (
              <span className="text-xs text-muted-foreground">{t("servicePreviews.closed", { when: formatRelative(p.closedAt) })}</span>
            )}
            <span className="ml-auto flex items-center gap-2">
              {p.url && (
                <a href={p.url} target="_blank" rel="noreferrer" className="font-mono text-[12.5px]">
                  {p.url.replace(/^https?:\/\//, "")}
                </a>
              )}
              {p.previewServiceId && (
                <Link
                  to="/p/$projectId/s/$serviceId"
                  params={{ projectId: service.projectId, serviceId: p.previewServiceId }}
                  className="text-[12.5px] font-medium"
                >
                  {t("servicePreviews.open")}
                </Link>
              )}
              {p.previewServiceId && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("servicePreviews.delete", { pr: p.prNumber })}
                  onClick={() => setRemoving(p)}
                >
                  <IconTrash size={15} />
                </Button>
              )}
            </span>
          </div>
        ))
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("servicePreviews.deleteTitle", { pr: removing?.prNumber ?? 0 })}
        description={t("servicePreviews.deleteBody")}
        confirmLabel={t("service.remove")}
        destructive
        onConfirm={() =>
          removing ? remove.mutateAsync({ serviceId: service.id, previewId: removing.id }).then(() => undefined) : undefined
        }
      />
    </Card>
  );
}
