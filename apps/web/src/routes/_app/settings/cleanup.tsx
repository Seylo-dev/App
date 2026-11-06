// Settings > Docker cleanup: per node, preview what would be removed (only
// resources this panel created) and how much space it frees, then run it.

import { cleanup, nodes, type OpInput, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { StatusDot } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { formatBytes } from "../../../components/settings/format";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { LoadingLines, OpErrorCallout } from "../../../components/settings/op-state";
import { Field, SettingsPage } from "../../../components/settings/page";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/cleanup")({
  component: CleanupPage,
});

type Input = OpInput<typeof cleanup.preview>;
type Result = OpOutput<typeof cleanup.preview>;
const kinds = ["images", "buildCache", "stoppedContainers", "orphanedServiceData"] as const;
type Kind = (typeof kinds)[number];

function CleanupPage() {
  const nodeList = useOp(nodes.list, {});
  const [nodeId, setNodeId] = useState("");
  const [picked, setPicked] = useState<Record<Kind, boolean>>({
    images: true,
    buildCache: true,
    stoppedContainers: true,
    orphanedServiceData: false,
  });
  const [asked, setAsked] = useState<Input | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [ran, setRan] = useState<Result | null>(null);
  const input: Input = { nodeId, ...picked };
  const preview = useOp(cleanup.preview, asked ?? input, { enabled: asked !== null, staleTime: 0 });
  const run = useSettingsMutation(cleanup.run, {
    success: (out) => t("settings.cleanup.done", { size: formatBytes(out.bytes) }),
    onSuccess: (out) => {
      setRan(out);
      setAsked(null);
    },
  });
  const node = nodeList.data?.nodes.find((n) => n.id === nodeId);
  const changedSinceAsk = asked !== null && JSON.stringify(asked) !== JSON.stringify(input);
  const nothingPicked = kinds.every((k) => !picked[k]);

  return (
    <SettingsPage title={t("settings.cleanup.title")} subtitle={t("settings.cleanup.subtitle")}>
      <SectionCard title={t("settings.cleanup.what")} description={t("settings.cleanup.onlyOurs")}>
        {nodeList.error && <OpErrorCallout error={nodeList.error} onRetry={() => void nodeList.refetch()} />}
        <Field label={t("settings.cleanup.node")} htmlFor="cleanup-node">
          <Select
            value={nodeId}
            onValueChange={(v) => {
              setNodeId(v);
              setRan(null);
            }}
          >
            <SelectTrigger id="cleanup-node" className="sm:w-72">
              <SelectValue placeholder={nodeList.isPending ? t("common.loading") : t("settings.cleanup.pickNode")} />
            </SelectTrigger>
            <SelectContent>
              {nodeList.data?.nodes.map((n) => (
                <SelectItem key={n.id} value={n.id} disabled={n.status !== "online"}>
                  <span className="flex items-center gap-2">
                    <StatusDot status={n.status === "online" ? "ok" : "off"} />
                    {n.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {kinds.map((kind) => (
            <label key={kind} htmlFor={`cleanup-${kind}`} className="flex cursor-pointer items-start gap-2.5 rounded-control bg-raised p-3">
              <Checkbox
                id={`cleanup-${kind}`}
                className="mt-0.5"
                checked={picked[kind]}
                onCheckedChange={(v) => setPicked({ ...picked, [kind]: v === true })}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium">{t(`settings.cleanup.kinds.${kind}.name`)}</span>
                <span className="text-xs text-muted-foreground">{t(`settings.cleanup.kinds.${kind}.hint`)}</span>
              </span>
            </label>
          ))}
        </div>
        {picked.orphanedServiceData && <Alert tone="warning">{t("settings.cleanup.orphanWarning")}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            disabled={!nodeId || nothingPicked}
            onClick={() => {
              setRan(null);
              setAsked(input);
              if (!changedSinceAsk && asked) void preview.refetch();
            }}
          >
            {t("settings.cleanup.preview")}
          </Button>
          <Button
            variant="destructive"
            disabled={!nodeId || nothingPicked || !preview.data || changedSinceAsk || preview.data.items.length === 0}
            onClick={() => setConfirm(true)}
          >
            {t("settings.cleanup.run")}
          </Button>
        </div>
      </SectionCard>

      {asked && (
        <SectionCard title={t("settings.cleanup.previewTitle", { node: node?.name ?? "" })}>
          {changedSinceAsk && <Alert tone="neutral">{t("settings.cleanup.stale")}</Alert>}
          {preview.isFetching && !preview.data ? (
            <LoadingLines rows={3} />
          ) : preview.error ? (
            <OpErrorCallout error={preview.error} onRetry={() => void preview.refetch()} />
          ) : (
            preview.data && (
              <ResultList result={preview.data} label={t("settings.cleanup.frees", { size: formatBytes(preview.data.bytes) })} />
            )
          )}
        </SectionCard>
      )}

      {ran && (
        <SectionCard title={t("settings.cleanup.ranTitle", { node: node?.name ?? "" })}>
          <ResultList result={ran} label={t("settings.cleanup.freed", { size: formatBytes(ran.bytes) })} />
        </SectionCard>
      )}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("settings.cleanup.confirmTitle", { node: node?.name ?? "" })}
        description={t("settings.cleanup.confirmDescription", {
          count: preview.data?.items.length ?? 0,
          size: formatBytes(preview.data?.bytes ?? 0),
        })}
        confirmLabel={t("settings.cleanup.run")}
        confirmText={picked.orphanedServiceData ? node?.name : undefined}
        destructive
        onConfirm={() => run.mutateAsync(input).then(() => undefined)}
      />
    </SettingsPage>
  );
}

function ResultList({ result, label }: { result: Result; label: string }) {
  if (result.items.length === 0) return <p className="m-0 text-[13px] text-muted-foreground">{t("settings.cleanup.nothing")}</p>;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13.5px] font-semibold">{label}</span>
      <ul className="m-0 flex max-h-80 flex-col gap-1 overflow-y-auto rounded-control bg-raised p-3 pl-7 font-mono text-xs text-ink-strong">
        {result.items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat; their order is the identity.
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
