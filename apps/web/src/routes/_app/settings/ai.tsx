// Settings > AI assistant: the Anthropic key, model routing between Haiku,
// Sonnet and Opus, a monthly budget, who may use it, whether it has its own
// Assistant page in the sidebar, and this month's usage with the bill
// projected from the pace so far.

import { ai, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { DataTable } from "@seylo/ui/components/data-table";
import { Input } from "@seylo/ui/components/input";
import { Progress, usageTone } from "@seylo/ui/components/progress";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { SectionCard, SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { SmoothChart } from "@seylo/ui/components/smooth-chart";
import { StatTile } from "@seylo/ui/components/stat-tile";
import { Switch } from "@seylo/ui/components/switch";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { dailySeries, recentMonths } from "../../../components/settings/ai/usage";
import { formatUsd } from "../../../components/settings/format";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { OpErrorCallout, QueryView } from "../../../components/settings/op-state";
import { Field, FormActions, SettingRow, SettingsPage } from "../../../components/settings/page";
import { FieldSkeleton, FormActionsSkeleton, SettingRowSkeleton } from "../../../components/settings/skeletons";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/ai")({
  component: AiPage,
});

type Settings = OpOutput<typeof ai.settings>;
type Tier = Settings["routing"]["model"];
const tiers: Tier[] = ["haiku", "sonnet", "opus"];

function AiPage() {
  const query = useOp(ai.settings, {});
  return (
    <SettingsPage title={t("settingsAi.title")} subtitle={t("settingsAi.subtitle")}>
      <QueryView query={query} skeleton={<AiSkeleton />} className="flex flex-col gap-4">
        {(data) => <AiSettingsForm saved={data} />}
      </QueryView>
      <Usage />
    </SettingsPage>
  );
}

function AiSkeleton() {
  return (
    <>
      <SectionCardSkeleton header={false}>
        <SettingRowSkeleton titleWidth="w-44" />
        <SettingRowSkeleton titleWidth="w-56" />
        <SettingRowSkeleton titleWidth="w-48" />
      </SectionCardSkeleton>
      <SectionCardSkeleton titleWidth="w-36" description="w-96">
        <FieldSkeleton span hint />
        <FormActionsSkeleton />
      </SectionCardSkeleton>
      <SectionCardSkeleton titleWidth="w-24" description="w-[min(480px,100%)]">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Skeleton className="h-[65px] bg-raised" />
          <Skeleton className="h-[65px] bg-raised" />
        </div>
        <SettingRowSkeleton titleWidth="w-48" />
      </SectionCardSkeleton>
      <SectionCardSkeleton titleWidth="w-28" description="w-80">
        <FieldSkeleton hint className="sm:w-64" />
        <FormActionsSkeleton />
      </SectionCardSkeleton>
    </>
  );
}

/** The month's tiles and the two usage tables while they load. */
function UsageSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex min-w-0 flex-col gap-1.5 rounded-control bg-raised px-4 py-3">
            <SkeletonText className="w-20 text-[12.5px]" />
            <SkeletonText className="w-16 text-[22px]" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-40 bg-raised" />
        <Skeleton className="h-40 bg-raised" />
      </div>
    </>
  );
}

/**
 * Switches and the model choice apply right away, as everywhere in settings;
 * the key and the budget are typed, so each card saves its own field.
 */
function AiSettingsForm({ saved }: { saved: Settings }) {
  const [key, setKey] = useState("");
  const [budget, setBudget] = useState(saved.monthlyBudgetUsd === null ? "" : String(saved.monthlyBudgetUsd));
  const refresh = [ai.settings, ai.usage, ai.me];
  const toggle = useSettingsMutation(ai.updateSettings, { invalidates: refresh, success: t("settings.saved") });
  const route = useSettingsMutation(ai.updateSettings, { invalidates: refresh, success: t("settings.saved") });
  const saveKey = useSettingsMutation(ai.updateSettings, {
    invalidates: refresh,
    success: t("settings.saved"),
    onSuccess: () => setKey(""),
  });
  const saveBudget = useSettingsMutation(ai.updateSettings, { invalidates: refresh, success: t("settings.saved") });

  // A switch shows what it is being set to while that saves.
  const pending = toggle.isPending ? toggle.variables : undefined;
  const enabled = pending?.enabled ?? saved.enabled;
  const allowMembers = pending?.allowMembers ?? saved.allowMembers;
  const chatPage = pending?.chatPage ?? saved.chatPage;
  const routing = (route.isPending ? route.variables?.routing : undefined) ?? saved.routing;
  const setRouting = (patch: Partial<Settings["routing"]>) => route.mutate({ routing: { ...routing, ...patch } });

  const budgetValue = budget.trim() === "" ? null : Number(budget);
  const budgetInvalid = budgetValue !== null && (!Number.isFinite(budgetValue) || budgetValue < 0 || budgetValue > 100_000);
  const keyInvalid = key.trim() !== "" && key.trim().length < 20;

  return (
    <>
      <SectionCard>
        <SettingRow
          title={t("settingsAi.enabled")}
          description={saved.keySet ? t("settingsAi.enabledHint") : t("settingsAi.needsKey")}
          control={
            <Switch
              checked={enabled}
              disabled={!saved.keySet || toggle.isPending}
              onCheckedChange={(on) => toggle.mutate({ enabled: on })}
              aria-label={t("settingsAi.enabled")}
            />
          }
        />
        <SettingRow
          title={t("settingsAi.allowMembers")}
          description={t("settingsAi.allowMembersHint")}
          control={
            <Switch
              checked={allowMembers}
              disabled={toggle.isPending}
              onCheckedChange={(on) => toggle.mutate({ allowMembers: on })}
              aria-label={t("settingsAi.allowMembers")}
            />
          }
        />
        <SettingRow
          title={t("settingsAi.chatPage")}
          description={t("settingsAi.chatPageHint")}
          control={
            <Switch
              checked={chatPage}
              disabled={toggle.isPending}
              onCheckedChange={(on) => toggle.mutate({ chatPage: on })}
              aria-label={t("settingsAi.chatPage")}
            />
          }
        />
      </SectionCard>

      <SectionCard title={t("settingsAi.keyTitle")} description={t("settingsAi.keyDescription")}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim() && !keyInvalid) saveKey.mutate({ anthropicApiKey: key.trim() });
          }}
        >
          <Field
            label={saved.keySet ? t("settingsAi.replaceKey") : t("settingsAi.key")}
            hint={saved.keySet ? t("settingsAi.keyStored", { hint: saved.keyHint }) : t("settingsAi.keyHint")}
            error={keyInvalid ? t("settingsAi.keyInvalid") : null}
            htmlFor="ai-key"
          >
            <div className="flex gap-2">
              <Input
                id="ai-key"
                type="password"
                autoComplete="off"
                value={key}
                placeholder={saved.keySet ? `sk-ant-...${saved.keyHint}` : "sk-ant-..."}
                className="font-mono text-[12.5px]"
                onChange={(e) => setKey(e.target.value)}
              />
              {saved.keySet && (
                <Button
                  className="bg-muted shadow-none"
                  disabled={saveKey.isPending}
                  onClick={() => saveKey.mutate({ anthropicApiKey: null, enabled: false })}
                >
                  {t("settings.remove")}
                </Button>
              )}
            </div>
          </Field>
          <FormActions>
            <Button type="submit" variant="primary" disabled={!key.trim() || keyInvalid || saveKey.isPending}>
              {saveKey.isPending ? t("settings.saving") : t("settings.save")}
            </Button>
          </FormActions>
        </form>
      </SectionCard>

      <SectionCard title={t("settingsAi.routingTitle")} description={t("settingsAi.routingDescription")}>
        <RadioGroup
          value={routing.mode}
          onValueChange={(v) => setRouting({ mode: v as Settings["routing"]["mode"] })}
          disabled={route.isPending}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          <RadioCard value="auto" title={t("settingsAi.auto")} description={t("settingsAi.autoHint")} />
          <RadioCard value="fixed" title={t("settingsAi.fixed")} description={t("settingsAi.fixedHint")} />
        </RadioGroup>
        {routing.mode === "fixed" ? (
          <Field label={t("settingsAi.model")} htmlFor="ai-model">
            <Select value={routing.model} onValueChange={(v) => setRouting({ model: v as Tier })} disabled={route.isPending}>
              <SelectTrigger id="ai-model" className="sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tiers.map((tier) => (
                  <SelectItem key={tier} value={tier}>
                    {t(`settingsAi.tiers.${tier}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <SettingRow
            className="border-t-0"
            title={t("settingsAi.allowOpus")}
            description={t("settingsAi.allowOpusHint")}
            control={
              <Switch
                checked={routing.allowOpus}
                disabled={route.isPending}
                onCheckedChange={(allowOpus) => setRouting({ allowOpus })}
                aria-label={t("settingsAi.allowOpus")}
              />
            }
          />
        )}
      </SectionCard>

      <SectionCard title={t("settingsAi.budgetTitle")} description={t("settingsAi.budgetDescription")}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!budgetInvalid) saveBudget.mutate({ monthlyBudgetUsd: budgetValue });
          }}
        >
          <Field
            label={t("settingsAi.budget")}
            hint={t("settingsAi.budgetHint")}
            error={budgetInvalid ? t("settingsAi.budgetInvalid") : null}
            htmlFor="ai-budget"
          >
            <div className="relative sm:w-48">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[13.5px] text-muted-foreground">$</span>
              <Input
                id="ai-budget"
                inputMode="decimal"
                value={budget}
                placeholder={t("settingsAi.noLimit")}
                className="pl-6"
                onChange={(e) => setBudget(e.target.value)}
              />
            </div>
          </Field>
          <FormActions>
            <Button
              type="submit"
              variant="primary"
              disabled={budgetValue === saved.monthlyBudgetUsd || budgetInvalid || saveBudget.isPending}
            >
              {saveBudget.isPending ? t("settings.saving") : t("settings.save")}
            </Button>
          </FormActions>
        </form>
      </SectionCard>
    </>
  );
}

function Usage() {
  const months = recentMonths(new Date(), 6);
  const [month, setMonth] = useState(months[0] ?? "");
  const query = useOp(ai.usage, { month });
  return (
    <SectionCard
      title={t("settingsAi.usageTitle")}
      actions={
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger size="sm" className="w-40" aria-label={t("settingsAi.month")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {months.map((m) => (
              <SelectItem key={m} value={m}>
                {monthLabel(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {query.error ? (
        <OpErrorCallout error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <QueryView query={query} skeleton={<UsageSkeleton />} className="flex flex-col gap-4">
          {(data) => <UsageBody data={data} />}
        </QueryView>
      )}
    </SectionCard>
  );
}

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

type UsageData = OpOutput<typeof ai.usage>;

function UsageBody({ data }: { data: UsageData }) {
  const { daily, total, labels } = dailySeries(data.month, data.byDay, new Date());
  const budgetPercent = data.budgetUsd ? Math.min(100, (data.spentUsd / data.budgetUsd) * 100) : null;
  return (
    <div className="flex flex-col gap-4">
      {data.budgetReached && <Alert tone="warning">{t("settingsAi.budgetReached")}</Alert>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile bare label={t("settingsAi.spent")} value={formatUsd(data.spentUsd)} />
        <StatTile
          bare
          label={t("settingsAi.projected")}
          value={formatUsd(data.projectedUsd)}
          delta={
            data.budgetUsd !== null && data.projectedUsd > data.budgetUsd ? { value: t("settingsAi.overBudget"), tone: "bad" } : undefined
          }
        />
        <div className="flex min-w-0 flex-col gap-1.5">
          <StatTile
            bare
            label={t("settingsAi.budget")}
            value={data.budgetUsd === null ? t("settingsAi.noLimit") : formatUsd(data.budgetUsd)}
          />
          {budgetPercent !== null && <Progress value={budgetPercent} tone={usageTone(budgetPercent)} />}
        </div>
      </div>
      <SmoothChart
        aria-label={t("settingsAi.chart")}
        height={140}
        labels={labels}
        legend
        formatValue={(v) => formatUsd(v)}
        series={[
          { id: "total", label: t("settingsAi.runningTotal"), values: total },
          { id: "daily", label: t("settingsAi.perDay"), values: daily },
        ]}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DataTable
          aria-label={t("settingsAi.byModel")}
          rows={data.byModel}
          getRowId={(r) => r.model}
          empty={<p className="m-0 p-4 text-[13px] text-muted-foreground">{t("settingsAi.noUsage")}</p>}
          columns={[
            { id: "model", header: t("settingsAi.model"), cell: (r) => t(`settingsAi.tiers.${r.model}`) },
            { id: "requests", header: t("settingsAi.requests"), align: "right", cell: (r) => r.requests.toLocaleString() },
            {
              id: "tokens",
              header: t("settingsAi.tokens"),
              align: "right",
              hideOnMobile: true,
              cell: (r) => (r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens).toLocaleString(),
            },
            { id: "cost", header: t("settingsAi.cost"), align: "right", cell: (r) => formatUsd(r.costUsd) },
          ]}
        />
        <DataTable
          aria-label={t("settingsAi.byUser")}
          rows={data.byUser}
          getRowId={(r) => r.userId ?? r.name}
          initialSort={{ id: "cost", desc: true }}
          empty={<p className="m-0 p-4 text-[13px] text-muted-foreground">{t("settingsAi.noUsage")}</p>}
          columns={[
            { id: "name", header: t("settingsAi.person"), cell: (r) => r.name },
            { id: "cost", header: t("settingsAi.cost"), align: "right", sortValue: (r) => r.costUsd, cell: (r) => formatUsd(r.costUsd) },
          ]}
        />
      </div>
    </div>
  );
}
