// The Compose file tab of a stack: the pasted file in Monaco (or where it is
// read from in a repo), a dry run that shows which members would be
// created, updated or deleted, and Apply.

import { compose, type OpInput, type OpOutput, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { CodeEditor } from "../editor/code-editor";
import { Field } from "../field";
import { useInvalidate } from "../invalidate";
import { MutationError, OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";

type ComposeSource = OpInput<typeof compose.update>["source"];
type Preview = OpOutput<typeof compose.update>;
const actionTone = { create: "green", update: "blue", delete: "red", unchanged: "gray" } as const;

export function ComposeFilePage({ service }: { service: ServiceDetail }) {
  const stack = useOp(compose.get, { serviceId: service.id }, { retry: retryOp });
  if (stack.isPending) return <Skeleton className="h-96 w-full rounded-card" />;
  if (stack.isError) return <OpErrorNote error={stack.error} />;
  return <ComposeEditor service={service} initial={stack.data.source} />;
}

function ComposeEditor({ service, initial }: { service: ServiceDetail; initial: ComposeSource }) {
  const [source, setSource] = useState<ComposeSource>(initial);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const invalidate = useInvalidate();
  const dryRun = useOpMutation(compose.update, { onSuccess: setPreview });
  const apply = useOpMutation(compose.update, {
    onSuccess: () => {
      setPreview(null);
      invalidate(compose.get, services.get, services.list);
      toast.success(t("serviceSource.compose.applied"));
    },
  });
  const deletes = preview?.members.filter((m) => m.action === "delete") ?? [];

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title={t("serviceSource.compose.title")} description={t("serviceSource.compose.description")}>
        {source.type === "inline" ? (
          <div className="overflow-hidden rounded-control shadow-[inset_0_0_0_1px_var(--input)]">
            <CodeEditor
              value={source.yaml}
              language="yaml"
              onChange={(yaml) => {
                setSource({ type: "inline", yaml });
                setPreview(null);
              }}
              height={460}
              aria-label={t("serviceSource.compose.title")}
            />
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            <Field label={t("serviceSource.compose.repo")}>
              <Input className="font-mono" value={source.type === "github" ? source.repo : source.url} readOnly />
            </Field>
            <Field label={t("serviceSource.github.branch")}>
              <Input
                className="font-mono"
                value={source.branch}
                onChange={(e) => {
                  setSource({ ...source, branch: e.target.value });
                  setPreview(null);
                }}
              />
            </Field>
            <Field label={t("serviceSource.compose.path")}>
              <Input
                className="font-mono"
                value={source.path}
                onChange={(e) => {
                  setSource({ ...source, path: e.target.value });
                  setPreview(null);
                }}
              />
            </Field>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => dryRun.mutate({ serviceId: service.id, source, dryRun: true })} disabled={dryRun.isPending}>
            {t("serviceSource.compose.preview")}
          </Button>
          <Button variant="primary" onClick={() => setConfirm(true)} disabled={!preview || apply.isPending}>
            {t("serviceSource.compose.apply")}
          </Button>
          <MutationError error={dryRun.error ?? apply.error} />
        </div>
      </SectionCard>
      {preview && (
        <SectionCard title={t("serviceSource.compose.changes")} flush>
          {preview.warnings.length > 0 && (
            <Callout tone="warning" className="mx-5 mb-3">
              <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}
          {preview.members.map((m) => (
            <div key={m.name} className="flex flex-wrap items-center gap-2.5 border-t border-divider px-5 py-3 text-[13px]">
              <Chip tone={actionTone[m.action]}>{t(`serviceSource.compose.action.${m.action}`)}</Chip>
              <b className="font-semibold">{m.name}</b>
              <span className="font-mono text-xs text-muted-foreground">{m.image}</span>
              {m.ports.length > 0 && <span className="font-mono text-xs text-muted-foreground">:{m.ports.join(", :")}</span>}
              {m.volumes.length > 0 && <Chip tone="gray">{t("serviceSource.compose.volumes", { count: m.volumes.length })}</Chip>}
              {m.dependsOn.length > 0 && (
                <span className="ml-auto text-xs text-muted-foreground">
                  {t("serviceSource.compose.dependsOn", { names: m.dependsOn.join(", ") })}
                </span>
              )}
            </div>
          ))}
        </SectionCard>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("serviceSource.compose.applyTitle")}
        description={
          deletes.length
            ? t("serviceSource.compose.applyDeletes", { names: deletes.map((m) => m.name).join(", ") })
            : t("serviceSource.compose.applyBody")
        }
        destructive={deletes.length > 0}
        confirmText={deletes.length ? service.name : undefined}
        confirmLabel={t("serviceSource.compose.apply")}
        onConfirm={() => apply.mutateAsync({ serviceId: service.id, source }).then(() => undefined)}
      />
    </div>
  );
}
