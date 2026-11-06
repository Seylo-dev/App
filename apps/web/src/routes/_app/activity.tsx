// Activity: the audit log. Who did what, when and from where, with
// filters, "Load more" paging and an export. Without audit.view people see
// only their own entries (the panel filters; nothing to do here).

import { audit, type OpOutput } from "@seylo/ops";
import { useOpClient } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { DataTable } from "@seylo/ui/components/data-table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@seylo/ui/components/dropdown-menu";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { KeyValue } from "@seylo/ui/components/key-value";
import { PageHeader } from "@seylo/ui/components/page-header";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@seylo/ui/components/sheet";
import { toast } from "@seylo/ui/components/toast";
import { Tip } from "@seylo/ui/components/tooltip";
import { IconActivity, IconDownload, IconSearch, IconX } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { areaLabel } from "../../components/settings/actions";
import { type ActivityFilters, downloadText, emptyFilters, filtersToInput, opModules, opSentence } from "../../components/settings/audit";
import { describeUserAgent, formatDateTime, formatDuration, formatRelative } from "../../components/settings/format";
import { OpErrorCallout, toastError } from "../../components/settings/op-state";
import { useOpPages } from "../../components/settings/paging";
import { t } from "../../i18n/t";

export const Route = createFileRoute("/_app/activity")({
  component: ActivityPage,
});

type Entry = OpOutput<typeof audit.list>["entries"][number];
const actorTypes = ["user", "apiKey", "mcp", "ai", "agent", "system", "anonymous"] as const;
const actorTones = { user: "blue", apiKey: "gray", mcp: "violet", ai: "violet", agent: "sky", system: "gray", anonymous: "amber" } as const;

function ActivityPage() {
  const [filters, setFilters] = useState<ActivityFilters>(emptyFilters);
  const deferred = useDeferredValue(filters);
  const input = filtersToInput(deferred);
  const pages = useOpPages(audit.list, input, (page) => page.nextCursor);
  const [open, setOpen] = useState<Entry | null>(null);
  const entries = pages.data?.pages.flatMap((p) => p.entries) ?? [];
  const set = <K extends keyof ActivityFilters>(key: K, value: ActivityFilters[K]) => setFilters({ ...filters, [key]: value });
  const filtered = JSON.stringify(filters) !== JSON.stringify(emptyFilters);

  return (
    <>
      <PageHeader title={t("activity.title")} subtitle={t("activity.subtitle")} actions={<ExportMenu filters={deferred} />} />
      <SectionCard flush contentClassName="gap-0">
        <div className="flex flex-wrap items-end gap-2 px-5 pt-4 pb-3">
          <div className="relative min-w-[200px] flex-[2_1_220px]">
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
          <label htmlFor="activity-from" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t("activity.filters.from")}
            <Input
              id="activity-from"
              type="date"
              value={filters.from}
              onChange={(e) => set("from", e.target.value)}
              className="h-8 w-[140px] text-[12.5px]"
            />
          </label>
          <label htmlFor="activity-to" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t("activity.filters.to")}
            <Input
              id="activity-to"
              type="date"
              value={filters.to}
              onChange={(e) => set("to", e.target.value)}
              className="h-8 w-[140px] text-[12.5px]"
            />
          </label>
          {filtered && (
            <Button size="sm" variant="ghost" onClick={() => setFilters(emptyFilters)}>
              <IconX size={14} />
              {t("activity.clear")}
            </Button>
          )}
        </div>
        {pages.error ? (
          <OpErrorCallout error={pages.error} onRetry={() => void pages.refetch()} className="mx-5 mb-5" />
        ) : (
          <DataTable<Entry>
            bare
            aria-label={t("activity.title")}
            loading={pages.isPending}
            rows={entries}
            getRowId={(e) => e.id}
            onRowClick={setOpen}
            minWidth={640}
            empty={<EmptyState compact icon={<IconActivity />} title={filtered ? t("activity.noMatch") : t("activity.empty")} />}
            columns={[
              {
                id: "when",
                header: t("activity.when"),
                width: "130px",
                cell: (e) => (
                  <Tip content={formatDateTime(e.at)}>
                    <span className="whitespace-nowrap text-muted-foreground">{formatRelative(e.at)}</span>
                  </Tip>
                ),
              },
              {
                id: "who",
                header: t("activity.who"),
                cell: (e) => (
                  <span className="flex min-w-0 items-center gap-2">
                    <Chip tone={actorTones[e.actor.type]}>{t(`activity.actors.${e.actor.type}`)}</Chip>
                    <span className="truncate">{e.actor.label}</span>
                  </span>
                ),
              },
              {
                id: "what",
                header: t("activity.what"),
                cell: (e) => (
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{opSentence(e.opId)}</span>
                    {e.target && (
                      <span className="truncate text-xs text-muted-foreground">
                        {e.target.label ?? e.target.id} <span className="text-ink-ghost">· {e.target.type}</span>
                      </span>
                    )}
                  </span>
                ),
              },
              {
                id: "from",
                header: t("activity.from"),
                hideOnMobile: true,
                cell: (e) => <span className="font-mono text-xs text-muted-foreground">{e.ip ?? "-"}</span>,
              },
              {
                id: "outcome",
                header: t("activity.result"),
                align: "right",
                cell: (e) =>
                  e.outcome === "ok" ? (
                    <Chip tone="green">{t("activity.outcomes.ok")}</Chip>
                  ) : (
                    <Chip tone="red" mono>
                      {e.errorCode ?? t("activity.outcomes.error")}
                    </Chip>
                  ),
              },
            ]}
          />
        )}
        {pages.hasNextPage && (
          <div className="flex justify-center border-t border-divider px-5 py-3">
            <Button size="sm" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
              {pages.isFetchingNextPage ? t("common.loading") : t("settings.loadMore")}
            </Button>
          </div>
        )}
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
      <SelectTrigger size="sm" aria-label={label} className="w-auto min-w-[130px] flex-[1_1_130px]">
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

function EntrySheet({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  return (
    <Sheet open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="max-w-lg">
        {entry && (
          <>
            <SheetHeader>
              <SheetTitle>{opSentence(entry.opId)}</SheetTitle>
              <SheetDescription className="font-mono text-xs">{entry.opId}</SheetDescription>
            </SheetHeader>
            <SheetBody className="pb-5">
              <KeyValue
                items={[
                  { label: t("activity.when"), value: formatDateTime(entry.at) },
                  { label: t("activity.who"), value: `${entry.actor.label} (${t(`activity.actors.${entry.actor.type}`)})` },
                  ...(entry.actor.credentialId ? [{ label: t("activity.credential"), value: entry.actor.credentialId, mono: true }] : []),
                  ...(entry.target
                    ? [{ label: t("activity.target"), value: `${entry.target.label ?? entry.target.id} (${entry.target.type})` }]
                    : []),
                  {
                    label: t("activity.result"),
                    value:
                      entry.outcome === "ok" ? t("activity.outcomes.ok") : `${t("activity.outcomes.error")}: ${entry.errorCode ?? "-"}`,
                  },
                  { label: t("activity.duration"), value: formatDuration(entry.durationMs) },
                  { label: t("activity.from"), value: entry.ip ?? "-", mono: true },
                  ...(entry.userAgent
                    ? [{ label: t("activity.browser"), value: describeUserAgent(entry.userAgent) ?? entry.userAgent }]
                    : []),
                  ...(entry.approvalId ? [{ label: t("activity.approval"), value: entry.approvalId, mono: true }] : []),
                ]}
              />
              <CodeBlock title={t("activity.input")} code={JSON.stringify(entry.input, null, 2)} maxHeight={360} />
              <p className="m-0 text-xs text-muted-foreground">{t("activity.redacted")}</p>
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
