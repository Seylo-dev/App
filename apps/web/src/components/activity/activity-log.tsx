// The audit log as a table, shared by the Activity page and a project's
// Activity tab, so both show an entry the same way: the action as a
// sentence, the result in words, times as "3 minutes ago", "Load more"
// under the table and the same detail sheet on a click. On a phone the
// table keeps two columns, What and Result: who and when move under the
// action as a second line, so nothing is cut off or scrolled away.

import { type audit, isOpErrorCode, type OpOutput } from "@seylo/ops";
import { Avatar } from "@seylo/ui/components/avatar";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { DataTable, type DataTableColumn } from "@seylo/ui/components/data-table";
import { KeyValue } from "@seylo/ui/components/key-value";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@seylo/ui/components/sheet";
import { Tip } from "@seylo/ui/components/tooltip";
import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { opSentence } from "../settings/audit";
import { describeUserAgent, formatDateTime, formatDuration, formatRelative } from "../settings/format";

export type ActivityEntry = OpOutput<typeof audit.list>["entries"][number];

const actorTones = { user: "blue", apiKey: "gray", mcp: "violet", ai: "violet", agent: "sky", system: "gray", anonymous: "amber" } as const;

/** A refused or failed entry's error code in words ("Needs approval"); a code the app does not know stays as it is. */
export function errorLabel(code: string | null): string {
  if (code === null) return t("activity.outcomes.error");
  return isOpErrorCode(code) ? t(`activity.errorCodes.${code}`) : code;
}

/** Done, or why not: a destructive op waiting for a person is amber, every other refusal red. */
export function ResultChip({ entry }: { entry: ActivityEntry }) {
  if (entry.outcome === "ok") return <Chip tone="green">{t("activity.outcomes.ok")}</Chip>;
  const known = entry.errorCode === null || isOpErrorCode(entry.errorCode);
  return (
    <Chip tone={entry.errorCode === "APPROVAL_REQUIRED" ? "amber" : "red"} mono={!known} className="whitespace-nowrap">
      {errorLabel(entry.errorCode)}
    </Chip>
  );
}

function When({ at }: { at: string }) {
  return (
    <Tip content={formatDateTime(at)}>
      <span className="whitespace-nowrap text-muted-foreground">{formatRelative(at)}</span>
    </Tip>
  );
}

/**
 * The columns. `target` adds the entry's target under the action (the
 * project's own tab leaves it out: every entry there is about the project).
 */
function activityColumns(target: boolean): DataTableColumn<ActivityEntry>[] {
  return [
    {
      id: "when",
      header: t("activity.when"),
      width: "130px",
      hideOnMobile: true,
      cell: (e) => <When at={e.at} />,
    },
    {
      id: "who",
      header: t("activity.who"),
      skeletonWidth: "38.7%",
      hideOnMobile: true,
      cell: (e) => (
        <span className="flex min-w-0 items-center gap-2">
          {e.actor.id && <Avatar name={e.actor.label} src={e.actor.avatarUrl} size="sm" decorative />}
          <Chip tone={actorTones[e.actor.type]}>{t(`activity.actors.${e.actor.type}`)}</Chip>
          <span className="min-w-0 [overflow-wrap:anywhere]">{e.actor.label}</span>
        </span>
      ),
    },
    {
      id: "what",
      header: t("activity.what"),
      skeletonLines: target ? 2 : 1,
      cell: (e) => (
        <span className="flex min-w-0 flex-col [overflow-wrap:anywhere]">
          <span className="font-medium">{opSentence(e.opId)}</span>
          {target && e.target && (
            <span className="text-xs text-muted-foreground">
              {e.target.label ?? e.target.id} <span className="text-ink-ghost">· {e.target.type}</span>
            </span>
          )}
          {/* On a phone the Who and When columns are hidden: the same facts as one line here. */}
          <span className="text-xs text-muted-foreground md:hidden">{`${e.actor.label}${t("format.separator")}${formatRelative(e.at)}`}</span>
        </span>
      ),
    },
    {
      id: "from",
      header: t("activity.from"),
      hideOnMobile: true,
      skeletonWidth: "12.3%",
      cell: (e) => <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">{e.ip ?? "-"}</span>,
    },
    {
      id: "outcome",
      header: t("activity.result"),
      align: "right",
      skeletonWidth: "14.2%",
      cell: (e) => <ResultChip entry={e} />,
    },
  ];
}

export function ActivityTable({
  entries,
  loading,
  empty,
  target = true,
  onOpen,
  "aria-label": label,
}: {
  entries: readonly ActivityEntry[];
  loading: boolean;
  empty: ReactNode;
  target?: boolean;
  onOpen: (entry: ActivityEntry) => void;
  "aria-label": string;
}) {
  return (
    <DataTable<ActivityEntry>
      bare
      aria-label={label}
      loading={loading}
      skeletonRows={5}
      rows={entries}
      getRowId={(e) => e.id}
      onRowClick={onOpen}
      empty={empty}
      columns={activityColumns(target)}
    />
  );
}

/** "Load more" on its own strip under the table, centered. */
export function LoadMore({ fetching, onMore }: { fetching: boolean; onMore: () => void }) {
  return (
    <div className="flex justify-center border-t border-divider px-5 py-3">
      <Button size="sm" disabled={fetching} onClick={onMore}>
        {fetching ? t("common.loading") : t("settings.loadMore")}
      </Button>
    </div>
  );
}

export function EntrySheet({ entry, onClose }: { entry: ActivityEntry | null; onClose: () => void }) {
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
                      entry.outcome === "ok"
                        ? t("activity.outcomes.ok")
                        : entry.errorCode && isOpErrorCode(entry.errorCode)
                          ? `${errorLabel(entry.errorCode)} (${entry.errorCode})`
                          : `${t("activity.outcomes.error")}: ${entry.errorCode ?? "-"}`,
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
