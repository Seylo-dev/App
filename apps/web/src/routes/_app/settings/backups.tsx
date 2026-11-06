// Settings > Backups: the S3-compatible buckets (AWS S3, Cloudflare R2,
// MinIO) database and volume backups go to. Each can be tested before it
// is saved; schedules live on each service's Backups tab.

import { backups, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { DataTable } from "@seylo/ui/components/data-table";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@seylo/ui/components/sheet";
import { IconBucket, IconPlus } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  type DestinationDraft,
  destinationInput,
  emptyDestination,
  endpointHint,
  providers,
} from "../../../components/settings/backups/destination";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { OpErrorCallout } from "../../../components/settings/op-state";
import { Field, FormGrid, SettingsPage } from "../../../components/settings/page";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/backups")({
  component: BackupsPage,
});

type Destination = OpOutput<typeof backups.listDestinations>["destinations"][number];
type TestResult = OpOutput<typeof backups.testDestination>;

function BackupsPage() {
  const list = useOp(backups.listDestinations, {});
  const [editing, setEditing] = useState<Destination | "new" | null>(null);
  const [deleting, setDeleting] = useState<Destination | null>(null);
  const remove = useSettingsMutation(backups.deleteDestination, {
    invalidates: [backups.listDestinations],
    success: t("settingsBackups.deleted"),
  });

  return (
    <SettingsPage
      title={t("settingsBackups.title")}
      subtitle={t("settingsBackups.subtitle")}
      actions={
        <Button variant="primary" onClick={() => setEditing("new")}>
          <IconPlus size={16} stroke={1.8} />
          {t("settingsBackups.add")}
        </Button>
      }
    >
      <SectionCard title={t("settingsBackups.destinations")} flush>
        {list.error ? (
          <OpErrorCallout error={list.error} onRetry={() => void list.refetch()} className="mx-5 mb-5" />
        ) : (
          <DataTable<Destination>
            bare
            aria-label={t("settingsBackups.destinations")}
            loading={list.isPending}
            rows={list.data?.destinations ?? []}
            getRowId={(d) => d.id}
            onRowClick={(d) => setEditing(d)}
            minWidth={560}
            empty={
              <EmptyState
                compact
                icon={<IconBucket />}
                title={t("settingsBackups.empty")}
                description={t("settingsBackups.emptyHint")}
                action={
                  <Button size="sm" onClick={() => setEditing("new")}>
                    {t("settingsBackups.add")}
                  </Button>
                }
              />
            }
            rowActions={(d) => [
              { label: t("settings.edit"), onSelect: () => setEditing(d) },
              {
                label: t("common.delete"),
                destructive: true,
                disabled: d.policyCount > 0,
                onSelect: () => setDeleting(d),
                separated: true,
              },
            ]}
            columns={[
              {
                id: "name",
                header: t("settingsBackups.fields.name"),
                sortValue: (d) => d.name,
                cell: (d) => (
                  <span className="flex items-center gap-2">
                    <Chip tone="sky">{t(`settingsBackups.providers.${d.provider}`)}</Chip>
                    <span className="font-medium">{d.name}</span>
                  </span>
                ),
              },
              {
                id: "bucket",
                header: t("settingsBackups.fields.bucket"),
                cell: (d) => (
                  <span className="font-mono text-[12.5px]">
                    {d.bucket}
                    {d.pathPrefix ? `/${d.pathPrefix}` : ""}
                  </span>
                ),
              },
              {
                id: "endpoint",
                header: t("settingsBackups.fields.endpoint"),
                hideOnMobile: true,
                cell: (d) => <span className="truncate font-mono text-xs text-muted-foreground">{d.endpoint}</span>,
              },
              {
                id: "used",
                header: t("settingsBackups.usedBy"),
                align: "right",
                cell: (d) => <span className="text-muted-foreground">{t("settingsBackups.schedules", { count: d.policyCount })}</span>,
              },
            ]}
          />
        )}
      </SectionCard>
      <DestinationSheet editing={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("settingsBackups.deleteTitle", { name: deleting?.name ?? "" })}
        description={t("settingsBackups.deleteDescription")}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={() => (deleting ? remove.mutateAsync({ destinationId: deleting.id }).then(() => undefined) : undefined)}
      />
    </SettingsPage>
  );
}

function DestinationSheet({ editing, onClose }: { editing: Destination | "new" | null; onClose: () => void }) {
  return (
    <Sheet open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="max-w-xl">
        {editing !== null && (
          <DestinationForm key={editing === "new" ? "new" : editing.id} saved={editing === "new" ? null : editing} onDone={onClose} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function DestinationForm({ saved, onDone }: { saved: Destination | null; onDone: () => void }) {
  const [draft, setDraft] = useState<DestinationDraft>(() => (saved ? { ...saved, secretAccessKey: "" } : emptyDestination));
  const [result, setResult] = useState<TestResult | null>(null);
  const refresh = [backups.listDestinations];
  const create = useSettingsMutation(backups.createDestination, {
    invalidates: refresh,
    success: t("settingsBackups.saved"),
    onSuccess: onDone,
  });
  const update = useSettingsMutation(backups.updateDestination, {
    invalidates: refresh,
    success: t("settingsBackups.saved"),
    onSuccess: onDone,
  });
  const test = useSettingsMutation(backups.testDestination, { onSuccess: setResult, failure: t("settingsBackups.testFailed") });
  const built = destinationInput(draft, saved !== null);
  const set = <K extends keyof DestinationDraft>(key: K, value: DestinationDraft[K]) => {
    setDraft({ ...draft, [key]: value });
    setResult(null);
  };
  const problem = (key: keyof DestinationDraft) => (!built.ok && built.errors.includes(key) ? t("settingsBackups.invalid") : null);

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (!built.ok) return;
    const { secretAccessKey, ...fields } = built.value;
    if (saved) update.mutate({ destinationId: saved.id, ...fields, ...(secretAccessKey ? { secretAccessKey } : {}) });
    else if (secretAccessKey) create.mutate({ ...fields, secretAccessKey });
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col gap-4">
      <SheetHeader>
        <SheetTitle>{saved ? t("settingsBackups.editTitle") : t("settingsBackups.addTitle")}</SheetTitle>
        <SheetDescription>{t("settingsBackups.formDescription")}</SheetDescription>
      </SheetHeader>
      <SheetBody>
        <Field label={t("settingsBackups.fields.provider")}>
          <RadioGroup
            value={draft.provider}
            onValueChange={(v) => set("provider", v as DestinationDraft["provider"])}
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {providers.map((p) => (
              <RadioCard key={p} value={p} title={t(`settingsBackups.providers.${p}`)} className="py-2.5" />
            ))}
          </RadioGroup>
        </Field>
        <FormGrid>
          <Field label={t("settingsBackups.fields.name")} htmlFor="dest-name" error={problem("name")} span>
            <Input id="dest-name" value={draft.name} maxLength={60} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field
            label={t("settingsBackups.fields.endpoint")}
            hint={endpointHint(draft.provider)}
            error={problem("endpoint")}
            htmlFor="dest-endpoint"
            span
          >
            <Input
              id="dest-endpoint"
              value={draft.endpoint}
              className="font-mono text-[12.5px]"
              placeholder="https://"
              onChange={(e) => set("endpoint", e.target.value)}
            />
          </Field>
          <Field label={t("settingsBackups.fields.bucket")} error={problem("bucket")} htmlFor="dest-bucket">
            <Input
              id="dest-bucket"
              value={draft.bucket}
              className="font-mono text-[12.5px]"
              onChange={(e) => set("bucket", e.target.value)}
            />
          </Field>
          <Field label={t("settingsBackups.fields.region")} error={problem("region")} htmlFor="dest-region">
            <Input
              id="dest-region"
              value={draft.region}
              className="font-mono text-[12.5px]"
              onChange={(e) => set("region", e.target.value)}
            />
          </Field>
          <Field
            label={t("settingsBackups.fields.pathPrefix")}
            hint={t("settingsBackups.pathPrefixHint")}
            error={problem("pathPrefix")}
            htmlFor="dest-prefix"
            span
          >
            <Input
              id="dest-prefix"
              value={draft.pathPrefix}
              className="font-mono text-[12.5px]"
              placeholder="backups/"
              onChange={(e) => set("pathPrefix", e.target.value)}
            />
          </Field>
          <Field label={t("settingsBackups.fields.accessKeyId")} error={problem("accessKeyId")} htmlFor="dest-key">
            <Input
              id="dest-key"
              value={draft.accessKeyId}
              autoComplete="off"
              className="font-mono text-[12.5px]"
              onChange={(e) => set("accessKeyId", e.target.value)}
            />
          </Field>
          <Field label={t("settingsBackups.fields.secretAccessKey")} error={problem("secretAccessKey")} htmlFor="dest-secret">
            <Input
              id="dest-secret"
              type="password"
              autoComplete="new-password"
              value={draft.secretAccessKey}
              placeholder={saved ? t("settingsNotifications.storedSecret") : undefined}
              onChange={(e) => set("secretAccessKey", e.target.value)}
            />
          </Field>
        </FormGrid>
        <label htmlFor="dest-path-style" className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-strong">
          <Checkbox id="dest-path-style" checked={draft.pathStyle} onCheckedChange={(v) => set("pathStyle", v === true)} />
          {t("settingsBackups.pathStyle")}
        </label>
        {result && (
          <Alert
            tone={result.ok ? "success" : "danger"}
            title={result.ok ? t("settingsBackups.testOk") : t("settingsBackups.testFailedStep", { step: result.failedStep ?? "-" })}
          >
            {result.message}
            {result.latencyMs !== null && ` (${result.latencyMs} ms)`}
          </Alert>
        )}
      </SheetBody>
      <SheetFooter>
        <Button
          className="mr-auto"
          disabled={!built.ok || test.isPending}
          onClick={() => {
            if (!built.ok) return;
            const { secretAccessKey, ...fields } = built.value;
            test.mutate({
              ...(saved ? { destinationId: saved.id } : {}),
              draft: { ...fields, ...(secretAccessKey ? { secretAccessKey } : {}) },
            });
          }}
        >
          {test.isPending ? t("settingsBackups.testing") : t("settingsBackups.test")}
        </Button>
        <Button onClick={onDone}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!built.ok || create.isPending || update.isPending}>
          {t("settings.save")}
        </Button>
      </SheetFooter>
    </form>
  );
}
