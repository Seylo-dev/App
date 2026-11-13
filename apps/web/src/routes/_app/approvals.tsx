// Approvals: changes that MCP tools and the AI assistant asked for, waiting
// for a person. Each shows what would run, on what, where it came from
// (chips: the assistant and its chat, or MCP and the token), why the model
// wants it, and the exact (redacted) input. Approving runs it at once with
// the approver's own permissions; denying tells the model, with a note.
// The assistant's chat shows the same approval as a card (one record), so
// deciding in either place updates both. One that weakens something
// (Approval.warning: a database's clients let in without TLS) says what
// and to whom, and approving it asks first with a red button, like a
// destructive one.

import { approvals, type OpOutput } from "@seylo/ops";
import { Alert } from "@seylo/ui/components/alert";
import { Avatar } from "@seylo/ui/components/avatar";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Chip, chipVariants } from "@seylo/ui/components/chip";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { PageHeader } from "@seylo/ui/components/page-header";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { ButtonSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Textarea } from "@seylo/ui/components/textarea";
import { cn } from "@seylo/ui/lib/utils";
import { IconChevronDown, IconChevronUp, IconMessage, IconPlugConnected, IconShieldCheck, IconSparkles } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ApprovalWarningChip, ApprovalWarningNote } from "../../components/approvals/approval-warning";
import { useAssistant, useAssistantAccess } from "../../components/assistant/assistant-context";
import { formatDateTime, formatRelative } from "../../components/settings/format";
import { useSettingsMutation } from "../../components/settings/mutation";
import { OpErrorCallout } from "../../components/settings/op-state";
import { useOpPages } from "../../components/settings/paging";
import { t } from "../../i18n/t";

export const Route = createFileRoute("/_app/approvals")({
  component: ApprovalsPage,
});

type Approval = approvals.Approval;
type Filter = "pending" | "all";

const statusTones = {
  pending: "amber",
  approved: "blue",
  rejected: "gray",
  expired: "gray",
  executed: "green",
  failed: "red",
} as const;

function ApprovalsPage() {
  const [filter, setFilter] = useState<Filter>("pending");
  const pages = useOpPages(approvals.list, { status: filter, limit: 30 }, (page) => page.nextCursor);
  const list = pages.data?.pages.flatMap((p) => p.approvals) ?? [];
  const pendingCount = pages.data?.pages[0]?.pendingCount ?? 0;

  return (
    <>
      <PageHeader
        title={t("approvals.title")}
        subtitle={t("approvals.subtitle")}
        actions={
          <Segmented value={filter} onValueChange={(v) => setFilter(v as Filter)} aria-label={t("approvals.filter")} tone="track">
            <SegmentedItem value="pending">
              {t("approvals.pending")}
              {pendingCount > 0 && (
                <span className="ml-1.5 rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground">{pendingCount}</span>
              )}
            </SegmentedItem>
            <SegmentedItem value="all">{t("approvals.all")}</SegmentedItem>
          </Segmented>
        }
      />
      {pages.error ? (
        <OpErrorCallout error={pages.error} onRetry={() => void pages.refetch()} />
      ) : pages.isPending ? (
        <LoadingRegion label={t("common.loading")} className="flex flex-col gap-3">
          <ApprovalCardSkeleton />
          <ApprovalCardSkeleton />
        </LoadingRegion>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconShieldCheck />}
            title={filter === "pending" ? t("approvals.emptyPending") : t("approvals.empty")}
            description={t("approvals.emptyHint")}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} />
          ))}
          {pages.hasNextPage && (
            <Button className="self-center" size="sm" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
              {pages.isFetchingNextPage ? t("common.loading") : t("settings.loadMore")}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

/** An approval card while the list loads: the title, the source chips, the details line, the reason, the input and the two actions. */
function ApprovalCardSkeleton() {
  return (
    <Card aria-hidden="true" className="gap-3 px-5 py-4">
      <div className="flex items-center gap-2">
        <SkeletonText className="w-36 text-[14.5px]" />
        <Skeleton className="ml-auto h-[22px] w-16 rounded-chip" />
      </div>
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-[22px] w-20 rounded-chip" />
        <Skeleton className="h-[22px] w-28 rounded-chip" />
      </div>
      <div className="flex flex-wrap gap-x-5 text-[12.5px]">
        <SkeletonText className="w-44" />
        <SkeletonText className="w-28" />
        <SkeletonText className="w-24" />
        <SkeletonText className="w-28" />
      </div>
      <div className="flex flex-col rounded-control bg-raised px-3.5 py-2.5">
        <SkeletonText className="mb-0.5 w-10 text-xs" />
        <SkeletonText className="w-2/3 text-[13px]" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-28" />
        {/* The input of a one-field op: three 12.5px lines at 1.7 with 12px above and below (the copy button floats in the code). */}
        <Skeleton className="h-[calc(3lh+24px)] text-[12.5px] leading-[1.7]" />
      </div>
      <div className="flex justify-end gap-2 border-t border-divider pt-3">
        <ButtonSkeleton className="w-16" />
        <ButtonSkeleton className="w-[120px]" />
      </div>
    </Card>
  );
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const pending = approval.status === "pending";
  const [showInput, setShowInput] = useState(pending);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");
  const refresh = [approvals.list, approvals.get];
  const approve = useSettingsMutation(approvals.approve, {
    invalidates: refresh,
    failure: false,
    success: (out: OpOutput<typeof approvals.approve>) => (out.status === "failed" ? t("approvals.ranFailed") : t("approvals.ran")),
  });
  const deny = useSettingsMutation(approvals.deny, { invalidates: refresh, success: t("approvals.denied") });
  const destructive = approval.opKind === "destructive";
  const warning = approval.warning;
  // Both ask before they run, with a red button.
  const careful = destructive || !!warning;

  return (
    <Card className="gap-3 px-5 py-4" aria-label={approval.opSummary}>
      {/* The status stays top right on every card: only the title side wraps. */}
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <b className="text-[14.5px] font-semibold">{approval.opSummary}</b>
          {destructive && <Chip tone="red">{t("approvals.destructive")}</Chip>}
          {warning && <ApprovalWarningChip warning={warning} />}
        </div>
        <Chip tone={statusTones[approval.status]} className="shrink-0">
          {t(`approvals.statuses.${approval.status}`)}
        </Chip>
      </div>

      <SourceChips source={approval.source} />

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          {approval.requestedBy.userId && (
            <Avatar
              name={approval.requestedBy.userName || approval.requestedBy.clientName}
              src={approval.requestedBy.avatarUrl}
              size="xs"
              decorative
              // Inside the 12.5px line without making it taller than its placeholder.
              className="-my-0.5"
            />
          )}
          {t("approvals.forPerson", { person: approval.requestedBy.userName })}
        </span>
        {approval.target && (
          <span>
            {t(`approvals.target.${approval.target.type}`)}: <span className="font-medium text-foreground">{approval.target.name}</span>
          </span>
        )}
        <span title={formatDateTime(approval.createdAt)}>{formatRelative(approval.createdAt)}</span>
        {pending && <span>{t("approvals.expires", { when: formatRelative(approval.expiresAt) })}</span>}
        <span className="font-mono">{approval.opId}</span>
      </div>

      {warning && <ApprovalWarningNote warning={warning} name={approval.target?.name ?? ""} className="text-[13px]" />}

      {approval.reason && (
        <blockquote className="m-0 rounded-control bg-raised px-3.5 py-2.5 text-[13px] text-ink-strong">
          <span className="mb-0.5 block text-xs font-medium text-muted-foreground">{t("approvals.reason")}</span>
          {approval.reason}
        </blockquote>
      )}

      <div>
        <Button size="sm" variant="ghost" aria-expanded={showInput} onClick={() => setShowInput(!showInput)}>
          {showInput ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
          {t("approvals.details")}
        </Button>
        {showInput && <CodeBlock className="mt-2" code={JSON.stringify(approval.inputPreview, null, 2)} maxHeight={280} />}
      </div>

      {approval.decidedBy && (
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {t("approvals.decidedBy", {
            person: approval.decidedBy.name,
            when: approval.decidedAt ? formatRelative(approval.decidedAt) : "",
          })}
        </p>
      )}
      {approval.error && (
        <Alert tone="danger" title={t("approvals.failedTitle")}>
          {approval.error}
        </Alert>
      )}
      {approve.error && (
        <Alert tone="danger" title={t("approvals.approveFailed")}>
          {approve.error.code === "FORBIDDEN" ? t("approvals.forbidden") : approve.error.message}
        </Alert>
      )}

      {pending && !denying && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-divider pt-3">
          <Button onClick={() => setDenying(true)}>{t("approvals.deny")}</Button>
          <Button variant={careful ? "destructive" : "primary"} disabled={approve.isPending} onClick={() => setConfirmApprove(true)}>
            {approve.isPending ? t("approvals.running") : t("approvals.approve")}
          </Button>
        </div>
      )}
      {pending && denying && (
        <form
          className="flex flex-col gap-2 border-t border-divider pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            deny.mutate({ approvalId: approval.id, ...(note.trim() ? { note: note.trim() } : {}) }, { onSuccess: () => setDenying(false) });
          }}
        >
          <label htmlFor={`deny-${approval.id}`} className="text-[12.5px] font-medium text-ink-strong">
            {t("approvals.note")}
          </label>
          <Textarea
            id={`deny-${approval.id}`}
            rows={2}
            maxLength={500}
            value={note}
            placeholder={t("approvals.notePlaceholder")}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDenying(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={deny.isPending}>
              {t("approvals.deny")}
            </Button>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={confirmApprove}
        onOpenChange={setConfirmApprove}
        title={t("approvals.confirmTitle", { action: approval.opSummary })}
        description={
          destructive ? t("approvals.confirmDestructive") : warning ? t("approvals.plain.confirm") : t("approvals.confirmDescription")
        }
        confirmLabel={t("approvals.approve")}
        destructive={careful}
        onConfirm={() => {
          setConfirmApprove(false);
          approve.mutate({ approvalId: approval.id });
        }}
      >
        {warning && <ApprovalWarningNote warning={warning} name={approval.target?.name ?? ""} className="text-[12.5px]" />}
      </ConfirmDialog>
    </Card>
  );
}

/**
 * Where the request came from, as chips under its title: "Assistant" and
 * the chat (its title for the person whose chat it is, else "Session
 * #<id>"; the person's own chat opens on a click), or "MCP" and the
 * token's name.
 */
function SourceChips({ source }: { source: Approval["source"] }) {
  const assistant = useAssistant();
  const access = useAssistantAccess();
  if (source.kind === "mcp") {
    return (
      <div data-slot="approval-source" className="flex flex-wrap items-center gap-1.5">
        <Chip tone="sky">
          <IconPlugConnected size={13} stroke={1.8} aria-hidden="true" />
          {t("approvals.via.mcp")}
        </Chip>
        <Chip tone="gray">{source.clientName}</Chip>
      </div>
    );
  }
  const label = source.title || t("approvals.session", { id: source.conversationId.slice(0, 6) });
  const opens = cn(
    chipVariants({ tone: "gray" }),
    "max-w-full cursor-pointer border-0 transition-interactive hover:bg-track hover:text-foreground",
  );
  const face = (
    <>
      <IconMessage size={13} stroke={1.8} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </>
  );
  return (
    <div data-slot="approval-source" className="flex flex-wrap items-center gap-1.5">
      <Chip tone="violet">
        <IconSparkles size={13} stroke={1.8} aria-hidden="true" />
        {t("approvals.via.ai")}
      </Chip>
      {!source.mine || !access.available ? (
        <Chip tone="gray" className="max-w-full">
          {face}
        </Chip>
      ) : access.page ? (
        <Link to="/assistant" search={{ c: source.conversationId }} title={t("approvals.openSession")} className={opens}>
          {face}
        </Link>
      ) : (
        <button
          type="button"
          title={t("approvals.openSession")}
          onClick={() => assistant.showChat(source.conversationId)}
          className={opens}
        >
          {face}
        </button>
      )}
    </div>
  );
}
