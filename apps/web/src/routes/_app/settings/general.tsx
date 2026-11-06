// Settings > General: panel name, panel domain (with its certificate state)
// and the node new services go to by default.

import { nodes, type OpOutput, settings } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { CopyField } from "@seylo/ui/components/copy-field";
import { Input } from "@seylo/ui/components/input";
import { SectionCard, SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { QueryView } from "../../../components/settings/op-state";
import { Field, FormActions, FormGrid, SettingRow, SettingsPage } from "../../../components/settings/page";
import { FieldSkeleton, FormActionsSkeleton, SettingRowSkeleton } from "../../../components/settings/skeletons";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/general")({
  component: GeneralPage,
});

type General = OpOutput<typeof settings.general>;

const noNode = "none";
const hostnamePattern = new RegExp(settings.Hostname.pattern ?? ".*");

function GeneralPage() {
  const query = useOp(settings.general, {});
  return (
    <SettingsPage title={t("settings.general.title")} subtitle={t("settings.general.subtitle")}>
      <QueryView query={query} skeleton={<GeneralSkeleton />} className="flex flex-col gap-4">
        {(data) => <GeneralForm key={`${data.name}|${data.domain}|${data.defaultNodeId}`} data={data} />}
      </QueryView>
    </SettingsPage>
  );
}

function GeneralForm({ data }: { data: General }) {
  const [name, setName] = useState(data.name);
  const [domain, setDomain] = useState(data.domain ?? "");
  const [defaultNodeId, setDefaultNodeId] = useState(data.defaultNodeId ?? noNode);
  const nodeList = useOp(nodes.list, {});
  const save = useSettingsMutation(settings.updateGeneral, {
    invalidates: [settings.general, settings.branding, settings.boot],
    success: t("settings.saved"),
  });

  const trimmedDomain = domain.trim().toLowerCase();
  const domainError = trimmedDomain !== "" && !hostnamePattern.test(trimmedDomain) ? t("settings.general.domainInvalid") : null;
  const nameError = name.trim() === "" ? t("settings.general.nameRequired") : null;
  const nodeValue = defaultNodeId === noNode ? null : defaultNodeId;
  const dirty = name.trim() !== data.name || (trimmedDomain || null) !== data.domain || nodeValue !== data.defaultNodeId;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (domainError || nameError) return;
    save.mutate({ name: name.trim(), domain: trimmedDomain === "" ? null : trimmedDomain, defaultNodeId: nodeValue });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <SectionCard title={t("settings.general.panelTitle")} description={t("settings.general.panelDescription")}>
        <FormGrid>
          <Field label={t("settings.general.name")} hint={t("settings.general.nameHint")} error={nameError} htmlFor="general-name" span>
            <Input id="general-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("settings.general.domain")} hint={t("settings.general.domainHint")} error={domainError} htmlFor="general-domain">
            <Input
              id="general-domain"
              value={domain}
              placeholder="panel.example.com"
              className="font-mono text-[12.5px]"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setDomain(e.target.value)}
            />
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
          <Button type="submit" variant="primary" disabled={!dirty || save.isPending || !!domainError || !!nameError}>
            {save.isPending ? t("settings.saving") : t("settings.save")}
          </Button>
        </FormActions>
      </SectionCard>

      <UptimeTargets allowed={data.uptimeAllowInternalTargets} />

      <SectionCard title={t("settings.general.addressTitle")} description={t("settings.general.addressDescription")}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-ink-strong">{t("settings.general.domainState")}</span>
          <Chip tone={domainTones[data.domainStatus.state]}>{t(`settings.general.domainStates.${data.domainStatus.state}`)}</Chip>
        </div>
        {data.domainStatus.message && <p className="m-0 text-[12.5px] text-muted-foreground">{data.domainStatus.message}</p>}
        <CopyField value={data.publicUrl} aria-label={t("settings.general.publicUrl")} />
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {t("settings.general.updatesHint")}{" "}
          <Link to="/settings/updates" className="text-link hover:text-link-hover">
            {t("settings.sections.updates")}
          </Link>
        </p>
      </SectionCard>
    </form>
  );
}

function GeneralSkeleton() {
  return (
    <>
      <SectionCardSkeleton titleWidth="w-14" description="w-64">
        <FormGrid>
          <FieldSkeleton span labelWidth="w-20" />
          <FieldSkeleton labelWidth="w-24" />
          <FieldSkeleton labelWidth="w-24" />
        </FormGrid>
        <FormActionsSkeleton />
      </SectionCardSkeleton>
      <SectionCardSkeleton titleWidth="w-28" description="w-96">
        <SettingRowSkeleton titleWidth="w-56" />
      </SectionCardSkeleton>
      <SectionCardSkeleton titleWidth="w-20" description="w-80">
        <SkeletonText className="w-28 text-[13px]" />
        <Skeleton className="h-[38px]" />
        <SkeletonText className="w-64 text-[12.5px]" />
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

const domainTones = {
  none: "gray",
  pending_dns: "amber",
  issuing_certificate: "blue",
  active: "green",
  error: "red",
} as const;
