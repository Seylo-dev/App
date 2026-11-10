// Settings > General: the panel's name and the node new services go to by
// default, the Panel domain card (the domain with its certificate state,
// "Serve on IP address" and the agents' port: panel-access-card.tsx),
// uptime check targets and how long the activity log keeps entries.

import { nodes, type OpOutput, settings } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Input } from "@seylo/ui/components/input";
import { SectionCard, SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { QueryView } from "../../../components/settings/op-state";
import { Field, FormActions, FormGrid, SettingRow, SettingsPage } from "../../../components/settings/page";
import { PanelDomainCard } from "../../../components/settings/panel-access-card";
import { FieldSkeleton, FormActionsSkeleton, SettingRowSkeleton } from "../../../components/settings/skeletons";
import { t } from "../../../i18n/t";
import { prefetchOp, startPrefetch } from "../../../lib/prefetch";

export const Route = createFileRoute("/_app/settings/general")({
  // The settings and the panel access card's data, together (the card used to wait for the settings).
  loader: ({ context }) =>
    startPrefetch(() => Promise.all([prefetchOp(context, settings.general, {}), prefetchOp(context, settings.panelAccess, {})])),
  component: GeneralPage,
});

type General = OpOutput<typeof settings.general>;

const noNode = "none";

function GeneralPage() {
  const query = useOp(settings.general, {});
  return (
    <SettingsPage title={t("settings.general.title")} subtitle={t("settings.general.subtitle")}>
      <QueryView query={query} skeleton={<GeneralSkeleton />} className="flex flex-col gap-4">
        {(data) => (
          <>
            <GeneralForm key={`${data.name}|${data.defaultNodeId}`} data={data} />
            <PanelDomainCard general={data} />
            <UptimeTargets allowed={data.uptimeAllowInternalTargets} />
            <AuditRetention days={data.auditRetentionDays} />
          </>
        )}
      </QueryView>
    </SettingsPage>
  );
}

function GeneralForm({ data }: { data: General }) {
  const [name, setName] = useState(data.name);
  const [defaultNodeId, setDefaultNodeId] = useState(data.defaultNodeId ?? noNode);
  const nodeList = useOp(nodes.list, {});
  const save = useSettingsMutation(settings.updateGeneral, {
    invalidates: [settings.general, settings.branding, settings.boot],
    success: t("settings.saved"),
  });

  const nameError = name.trim() === "" ? t("settings.general.nameRequired") : null;
  const nodeValue = defaultNodeId === noNode ? null : defaultNodeId;
  const dirty = name.trim() !== data.name || nodeValue !== data.defaultNodeId;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (nameError) return;
    save.mutate({ name: name.trim(), defaultNodeId: nodeValue });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <SectionCard title={t("settings.general.panelTitle")} description={t("settings.general.panelDescription")}>
        <FormGrid>
          <Field label={t("settings.general.name")} hint={t("settings.general.nameHint")} error={nameError} htmlFor="general-name">
            <Input id="general-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("settings.general.defaultNode")} hint={t("settings.general.defaultNodeHint")} htmlFor="general-node">
            <Select value={defaultNodeId} onValueChange={setDefaultNodeId}>
              <SelectTrigger id="general-node">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={noNode}>{t("settings.general.noDefaultNode")}</SelectItem>
                {nodeList.data?.nodes.map((node) => (
                  <SelectItem key={node.id} value={node.id}>
                    {node.name}
                  </SelectItem>
                ))}
                {/* Keep the saved value selectable while the node list loads or fails. */}
                {data.defaultNodeId && !nodeList.data && <SelectItem value={data.defaultNodeId}>{data.defaultNodeId}</SelectItem>}
              </SelectContent>
            </Select>
          </Field>
        </FormGrid>
        <FormActions>
          <Button type="submit" variant="primary" disabled={!dirty || save.isPending || !!nameError}>
            {save.isPending ? t("settings.saving") : t("settings.save")}
          </Button>
        </FormActions>
      </SectionCard>
    </form>
  );
}

function GeneralSkeleton() {
  return (
    <>
      <SectionCardSkeleton titleWidth="w-14" description="w-64">
        <FormGrid>
          <FieldSkeleton labelWidth="w-20" />
          <FieldSkeleton labelWidth="w-24" />
        </FormGrid>
        <FormActionsSkeleton />
      </SectionCardSkeleton>
      <SectionCardSkeleton titleWidth="w-28" description="w-96">
        <FieldSkeleton labelWidth="w-24" />
        <SkeletonText className="w-28 text-[13px]" />
        <Skeleton className="h-[38px]" />
        <SettingRowSkeleton titleWidth="w-36" />
        <SettingRowSkeleton titleWidth="w-28" />
      </SectionCardSkeleton>
      <SectionCardSkeleton titleWidth="w-28" description="w-96">
        <SettingRowSkeleton titleWidth="w-56" />
      </SectionCardSkeleton>
      <SectionCardSkeleton titleWidth="w-24" description="w-80">
        <SettingRowSkeleton titleWidth="w-40" />
      </SectionCardSkeleton>
    </>
  );
}

/** Uptime checks to internal addresses (loopback, private, cloud metadata): off unless an admin allows them. Saves on toggle. */
function UptimeTargets({ allowed }: { allowed: boolean }) {
  const save = useSettingsMutation(settings.updateGeneral, { invalidates: [settings.general], success: t("settings.saved") });
  const value = save.isPending && save.variables ? (save.variables.uptimeAllowInternalTargets ?? allowed) : allowed;
  return (
    <SectionCard title={t("settings.general.uptimeTitle")} description={t("settings.general.uptimeDescription")}>
      <SettingRow
        title={t("settings.general.uptimeInternal")}
        description={t("settings.general.uptimeInternalHint")}
        control={
          <Switch
            checked={value}
            disabled={save.isPending}
            onCheckedChange={(on) => save.mutate({ uptimeAllowInternalTargets: on })}
            aria-label={t("settings.general.uptimeInternal")}
          />
        }
      />
    </SectionCard>
  );
}

/** Choices for how long the activity log keeps entries; "forever" is null. */
const retentionChoices = [90, 180, 365, 730, 1825] as const;
const keepForever = "forever";

/** How long the audit log keeps entries. Saves on change. */
function AuditRetention({ days }: { days: number | null }) {
  const save = useSettingsMutation(settings.updateGeneral, { invalidates: [settings.general], success: t("settings.saved") });
  const current = save.isPending && save.variables?.auditRetentionDays !== undefined ? save.variables.auditRetentionDays : days;
  const value = current === null ? keepForever : String(current);
  // A value set through the API that is not one of the choices still shows.
  const choices =
    current === null || (retentionChoices as readonly number[]).includes(current) ? retentionChoices : [...retentionChoices, current];
  return (
    <SectionCard title={t("settings.general.auditTitle")} description={t("settings.general.auditDescription")}>
      <SettingRow
        title={t("settings.general.auditRetention")}
        description={t("settings.general.auditRetentionHint")}
        stack
        control={
          <Select
            value={value}
            disabled={save.isPending}
            onValueChange={(next) => save.mutate({ auditRetentionDays: next === keepForever ? null : Number(next) })}
          >
            <SelectTrigger className="w-full sm:w-[160px]" aria-label={t("settings.general.auditRetention")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((choice) => (
                <SelectItem key={choice} value={String(choice)}>
                  {choice % 365 === 0
                    ? t("settings.general.auditYears", { count: choice / 365 })
                    : t("settings.general.auditDays", { count: choice })}
                </SelectItem>
              ))}
              <SelectItem value={keepForever}>{t("settings.general.auditForever")}</SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SectionCard>
  );
}
