// The secret deploy URL (for CI and git hosts other than GitHub) and the
// log of recent webhook deliveries with what each one did.

import { webhooks } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { CopyField } from "@seylo/ui/components/copy-field";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { formatRelative } from "../format";
import { useInvalidate } from "../invalidate";
import { MutationError, OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";

const outcomeTone = { deployed: "green", ignored: "gray", rejected: "amber", failed: "red" } as const;

export function DeployTriggerCard({ service }: { service: ServiceDetail }) {
  const trigger = useOp(webhooks.getTrigger, { serviceId: service.id }, { retry: retryOp });
  const deliveries = useOp(webhooks.listDeliveries, { serviceId: service.id, limit: 20 }, { retry: retryOp });
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const invalidate = useInvalidate();
  const rotate = useOpMutation(webhooks.rotateTrigger, {
    onSuccess: (res) => {
      setFreshUrl(res.url);
      invalidate(webhooks.getTrigger);
    },
  });
  const remove = useOpMutation(webhooks.deleteTrigger, {
    onSuccess: () => {
      setFreshUrl(null);
      invalidate(webhooks.getTrigger);
    },
  });
  const redeliver = useOpMutation(webhooks.redeliver, {
    onSuccess: (res) => toast.success(t("serviceSource.trigger.redelivered", { count: res.requested })),
  });
  const failed = deliveries.data?.deliveries.some((d) => d.canRedeliver);

  return (
    <SectionCard
      title={t("serviceSource.trigger.title")}
      description={t("serviceSource.trigger.description")}
      actions={
        trigger.data?.configured ? (
          <>
            <Button size="sm" onClick={() => rotate.mutate({ serviceId: service.id })} disabled={rotate.isPending}>
              {t("serviceSource.trigger.rotate")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
              {t("service.remove")}
            </Button>
          </>
        ) : (
          trigger.data && (
            <Button size="sm" variant="primary" onClick={() => rotate.mutate({ serviceId: service.id })} disabled={rotate.isPending}>
              {t("serviceSource.trigger.create")}
            </Button>
          )
        )
      }
    >
      {trigger.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : trigger.isError ? (
        <OpErrorNote error={trigger.error} />
      ) : freshUrl ? (
        <div className="flex flex-col gap-1.5">
          <CopyField value={freshUrl} aria-label={t("serviceSource.trigger.url")} />
          <span className="text-xs text-chip-amber-fg">{t("serviceSource.trigger.shownOnce")}</span>
        </div>
      ) : trigger.data.configured ? (
        <p className="m-0 text-[13px] text-ink-strong">
          {t("serviceSource.trigger.configured", { hint: trigger.data.hint ?? "" })}{" "}
          <span className="text-muted-foreground">
            {trigger.data.lastUsedAt
              ? t("serviceSource.trigger.lastUsed", { when: formatRelative(trigger.data.lastUsedAt) })
              : t("serviceSource.trigger.neverUsed")}
          </span>
        </p>
      ) : (
        <p className="m-0 text-[13px] text-muted-foreground">{t("serviceSource.trigger.none")}</p>
      )}
      <MutationError error={rotate.error ?? remove.error} />
      {deliveries.data && deliveries.data.deliveries.length > 0 && (
        <div className="flex flex-col">
          <div className="flex items-center pb-1.5">
            <h3 className="m-0 text-[13px] font-semibold">{t("serviceSource.trigger.deliveries")}</h3>
            {failed && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => redeliver.mutate({ serviceId: service.id })}>
                {t("serviceSource.trigger.retryFailed")}
              </Button>
            )}
          </div>
          {deliveries.data.deliveries.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2 border-t border-divider py-2 text-[12.5px]">
              <Chip tone={outcomeTone[d.outcome]}>{t(`serviceSource.trigger.outcome.${d.outcome}`)}</Chip>
              <span className="font-mono text-xs">{d.event}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.detail}</span>
              <span className="text-xs whitespace-nowrap text-muted-foreground">{formatRelative(d.receivedAt)}</span>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("serviceSource.trigger.deleteTitle")}
        description={t("serviceSource.trigger.deleteBody")}
        confirmLabel={t("service.remove")}
        destructive
        onConfirm={() => remove.mutateAsync({ serviceId: service.id }).then(() => undefined)}
      />
    </SectionCard>
  );
}
