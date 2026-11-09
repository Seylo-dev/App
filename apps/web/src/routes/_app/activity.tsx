// Activity: the audit log. Who did what, when and from where, with
// filters, "Load more" paging and an export. Without audit.view people see
// only their own entries (the panel filters; nothing to do here).

import { audit } from "@seylo/ops";
import { useOpClient } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@seylo/ui/components/dropdown-menu";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { PageHeader } from "@seylo/ui/components/page-header";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { toast } from "@seylo/ui/components/toast";
import { IconActivity, IconDownload, IconSearch, IconX } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { type ActivityEntry, ActivityTable, EntrySheet, LoadMore } from "../../components/activity/activity-log";
import { areaLabel } from "../../components/settings/actions";
import { type ActivityFilters, downloadText, emptyFilters, filtersToInput, opModules } from "../../components/settings/audit";
import { OpErrorCallout, toastError } from "../../components/settings/op-state";
import { useOpPages } from "../../components/settings/paging";
import { t } from "../../i18n/t";

export const Route = createFileRoute("/_app/activity")({
  component: ActivityPage,
});

const actorTypes = ["user", "apiKey", "mcp", "ai", "agent", "system", "anonymous"] as const;

function ActivityPage() {
  const [filters, setFilters] = useState<ActivityFilters>(emptyFilters);
  const deferred = useDeferredValue(filters);
  const input = filtersToInput(deferred);
  const pages = useOpPages(audit.list, input, (page) => page.nextCursor);
  const [open, setOpen] = useState<ActivityEntry | null>(null);
  const entries = pages.data?.pages.flatMap((p) => p.entries) ?? [];
  const set = <K extends keyof ActivityFilters>(key: K, value: ActivityFilters[K]) => setFilters({ ...filters, [key]: value });
  const filtered = JSON.stringify(filters) !== JSON.stringify(emptyFilters);

  return (
    <>
      <PageHeader title={t("activity.title")} subtitle={t("activity.subtitle")} actions={<ExportMenu filters={deferred} />} />
      <SectionCard flush contentClassName="gap-0">
        {/* A phone gets a two-column grid (search, then two filters a row, From and To side by side); wider screens one wrapping row. */}
        <div className="grid grid-flow-row-dense grid-cols-2 gap-2 px-5 pt-4 pb-3 md:flex md:flex-wrap md:items-center">
          <div className="relative col-span-2 md:min-w-[200px] md:flex-[2_1_220px]">
            <IconSearch size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" />
            <Input
              value={filters.q}
              onChange={(e) => set("q", e.target.value)}
              placeholder={t("activity.search")}
              aria-label={t("activity.search")}
              className="h-8 pl-8 text-[12.5px]"
            />
          </div>
          <FilterSelect
            label={t("activity.filters.actor")}
            anyLabel={t("activity.any.actor")}
            value={filters.actorType}
            onChange={(v) => set("actorType", v)}
            options={actorTypes.map((a) => [a, t(`activity.actors.${a}`)])}
          />
          <FilterSelect
            label={t("activity.filters.area")}
            anyLabel={t("activity.any.area")}
            value={filters.module}
            onChange={(v) => set("module", v)}
            options={opModules.map((m) => [m, areaLabel(m)])}
          />
          <FilterSelect
            label={t("activity.filters.outcome")}
            anyLabel={t("activity.any.outcome")}
            value={filters.outcome}
            onChange={(v) => set("outcome", v)}
            options={[
              ["ok", t("activity.outcomes.ok")],
              ["error", t("activity.outcomes.error")],
            ]}
          />
          {/* From and To wrap as a pair, never one without the other. */}
          <div className="col-span-2 grid grid-cols-2 gap-2 md:flex md:items-center">
            <DateFilter id="activity-from" label={t("activity.filters.from")} value={filters.from} onChange={(v) => set("from", v)} />
            <DateFilter id="activity-to" label={t("activity.filters.to")} value={filters.to} onChange={(v) => set("to", v)} />
          </div>
          {filtered && (
            <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setFilters(emptyFilters)}>
              <IconX size={14} />
              {t("activity.clear")}
            </Button>
          )}
        </div>
        {pages.error ? (
          <OpErrorCallout error={pages.error} onRetry={() => void pages.refetch()} className="mx-5 mb-5" />
        ) : (
          <ActivityTable
            aria-label={t("activity.title")}
            loading={pages.isPending}
            entries={entries}
            onOpen={setOpen}
            empty={<EmptyState compact icon={<IconActivity />} title={filtered ? t("activity.noMatch") : t("activity.empty")} />}
          />
        )}
        {pages.hasNextPage && <LoadMore fetching={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />}
      </SectionCard>
      <EntrySheet entry={open} onClose={() => setOpen(null)} />
    </>
  );
}

function FilterSelect({
  label,
  anyLabel,
  value,
  onChange,
  options,
}: {
  label: string;
  anyLabel: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} className="min-w-0 md:w-auto md:min-w-[130px] md:flex-[1_1_130px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{anyLabel}</SelectItem>
        {options.map(([v, text]) => (
          <SelectItem key={v} value={v}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ExportMenu({ filters }: { filters: ActivityFilters }) {
  const client = useOpClient();
  const [busy, setBusy] = useState(false);
  async function run(format: "csv" | "jsonl") {
    setBusy(true);
    try {
      const { limit: _limit, ...input } = filtersToInput(filters);
      const out = await client.call(audit.exportLog, { ...input, format });
      downloadText(out.filename, out.contentType, out.content);
      if (out.truncated) toast.warning(t("activity.export.truncated", { count: out.rows }));
      else toast.success(t("activity.export.done", { count: out.rows }));
    } catch (error) {
      toastError(error, t("activity.export.failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={busy}>
          <IconDownload size={16} stroke={1.8} />
          {t("activity.export.button")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => void run("csv")}>{t("activity.export.csv")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("jsonl")}>{t("activity.export.jsonl")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DateFilter({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label htmlFor={id} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <Input
        id={id}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 min-w-0 flex-1 text-[12.5px] max-md:px-2 md:w-[140px] md:flex-none"
      />
    </label>
  );
}
