// Settings > Maintenance pages: panel-wide maintenance mode and the global
// page every service shows while it is in maintenance or down (unless it
// has its own), with a sandboxed preview.

import { maintenance, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { SectionCard, SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { Textarea } from "@seylo/ui/components/textarea";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { formatRelative } from "../../../components/settings/format";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { QueryView } from "../../../components/settings/op-state";
import { Field, FormActions, SettingRow, SettingsPage } from "../../../components/settings/page";
import { FormActionsSkeleton, SettingRowSkeleton } from "../../../components/settings/skeletons";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/maintenance")({
  component: MaintenancePage,
});

type Global = OpOutput<typeof maintenance.getGlobal>;
const refresh = [maintenance.getGlobal, maintenance.preview];

function MaintenancePage() {
  const query = useOp(maintenance.getGlobal, {});
  return (
    <SettingsPage title={t("settings.maintenance.title")} subtitle={t("settings.maintenance.subtitle")}>
      <QueryView query={query} skeleton={<MaintenanceSkeleton />} className="flex flex-col gap-5">
        {(data) => <MaintenanceForm key={data.updatedAt ?? "new"} saved={data} />}
      </QueryView>
      <Preview />
    </SettingsPage>
  );
}

function MaintenanceSkeleton() {
  return (
    <>
      <SectionCardSkeleton header={false}>
        <SettingRowSkeleton titleWidth="w-32" />
      </SectionCardSkeleton>
      <SectionCardSkeleton titleWidth="w-32" description="w-80" footer={<SkeletonText className="w-32" />}>
        <div className="flex flex-col gap-1.5">
          <SkeletonText className="w-20 text-[12.5px]" />
          <Skeleton className="h-[88px]" />
          <SkeletonText className="w-60 text-xs" />
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Skeleton className="h-[65px] bg-raised" />
          <Skeleton className="h-[65px] bg-raised" />
        </div>
        <FormActionsSkeleton />
      </SectionCardSkeleton>
    </>
  );
}

function MaintenanceForm({ saved }: { saved: Global }) {
  const [message, setMessage] = useState(saved.message);
  const [custom, setCustom] = useState(saved.html !== null);
  const [html, setHtml] = useState(saved.html ?? "");
  const [confirmOn, setConfirmOn] = useState(false);
  const save = useSettingsMutation(maintenance.setGlobal, { invalidates: refresh, success: t("settings.saved") });
  const toggle = useSettingsMutation(maintenance.setGlobal, {
    invalidates: refresh,
    success: (out) => (out.enabled ? t("settings.maintenance.on") : t("settings.maintenance.off")),
  });
  const htmlValue = custom ? html : null;
  const dirty = message !== saved.message || htmlValue !== saved.html;
  const htmlInvalid = custom && html.trim() === "";

  return (
    <>
      <SectionCard>
        <SettingRow
          title={t("settings.maintenance.mode")}
          description={t("settings.maintenance.modeHint")}
          control={
            <Switch
              checked={saved.enabled}
              disabled={toggle.isPending}
              aria-label={t("settings.maintenance.mode")}
              onCheckedChange={(enabled) => (enabled ? setConfirmOn(true) : toggle.mutate({ enabled: false }))}
            />
          }
        />
        {saved.enabled && <Alert tone="warning">{t("settings.maintenance.activeNow")}</Alert>}
      </SectionCard>

      <SectionCard
        title={t("settings.maintenance.pageTitle")}
        description={t("settings.maintenance.pageDescription")}
        footer={saved.updatedAt ? t("settings.maintenance.updated", { when: formatRelative(saved.updatedAt) }) : undefined}
      >
        <Field label={t("settings.maintenance.message")} hint={t("settings.maintenance.messageHint")} htmlFor="mt-message">
          <Textarea id="mt-message" rows={3} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <RadioGroup
          value={custom ? "custom" : "builtin"}
          onValueChange={(v) => setCustom(v === "custom")}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          <RadioCard value="builtin" title={t("settings.maintenance.builtin")} description={t("settings.maintenance.builtinHint")} />
          <RadioCard value="custom" title={t("settings.maintenance.custom")} description={t("settings.maintenance.customHint")} />
        </RadioGroup>
        {custom && (
          <Field label={t("settings.maintenance.html")} hint={t("settings.maintenance.htmlHint")} htmlFor="mt-html">
            <Textarea id="mt-html" mono rows={12} value={html} spellCheck={false} onChange={(e) => setHtml(e.target.value)} />
          </Field>
        )}
        <FormActions>
          <Button
            variant="primary"
            disabled={!dirty || htmlInvalid || save.isPending}
            onClick={() => save.mutate({ message, html: htmlValue })}
          >
            {save.isPending ? t("settings.saving") : t("settings.save")}
          </Button>
        </FormActions>
      </SectionCard>

      <ConfirmDialog
        open={confirmOn}
        onOpenChange={setConfirmOn}
        title={t("settings.maintenance.confirmTitle")}
        description={t("settings.maintenance.confirmDescription")}
        confirmLabel={t("settings.maintenance.turnOn")}
        destructive
        onConfirm={() => toggle.mutateAsync({ enabled: true }).then(() => undefined)}
      />
    </>
  );
}

function Preview() {
  const preview = useOp(maintenance.preview, {});
  return (
    <SectionCard title={t("settings.maintenance.previewTitle")} description={t("settings.maintenance.previewDescription")}>
      <QueryView query={preview} skeleton={<Skeleton className="h-[380px] bg-raised" />}>
        {(data) => (
          // No scripts, no same-origin: the page is shown, never run with the panel's cookies.
          <iframe
            title={t("settings.maintenance.previewTitle")}
            sandbox=""
            srcDoc={data.html}
            className="h-[380px] w-full rounded-control border-0 bg-raised shadow-[inset_0_0_0_1px_var(--input)]"
          />
        )}
      </QueryView>
    </SectionCard>
  );
}
