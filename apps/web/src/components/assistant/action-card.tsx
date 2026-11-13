// A tool call in the conversation, as a compact card: what the assistant
// did and on what ("Restarted api in acme-shop"), the outcome as a chip, a
// link to the thing, and the redacted input and result behind Details. A
// call that needs a person's approval is an approval card in place
// ("Restart api?" with Approve and Reject): it is the same approval as on
// the Approvals page (approvals.get, invalidated live), so deciding in
// either place updates both, and the reply goes on once it is decided.
// One that weakens something (Approval.warning: a database's clients let
// in without TLS) says what and to whom, and Approve asks first in red,
// like a destructive one.

import { type ai, approvals } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconBan,
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconLoader2,
  IconSearch,
  IconShieldCheck,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
import { t } from "../../i18n/t";
import { ApprovalWarningChip, ApprovalWarningNote } from "../approvals/approval-warning";
import { formatRelative } from "../settings/format";
import { useSettingsMutation } from "../settings/mutation";
import { actionPhrase, isDestructive, isLookup, type Phase } from "./phrases";

export type ToolCall = Extract<ai.AiMessagePart, { type: "tool_call" }>;

const statusTones = { running: "blue", done: "green", error: "red", needs_approval: "amber", denied: "gray" } as const;

const phaseOf: Record<ToolCall["status"], Phase> = {
  running: "running",
  done: "done",
  error: "failed",
  needs_approval: "ask",
  denied: "ask",
};

export function ToolCallCard({ part }: { part: ToolCall }) {
  return part.approvalId ? <ApprovalCard part={part} approvalId={part.approvalId} /> : <ActionCard part={part} />;
}

function StatusIcon({ status, lookup }: { status: ToolCall["status"]; lookup: boolean }) {
  const common = { size: 15, stroke: 1.9, "aria-hidden": true } as const;
  switch (status) {
    case "running":
      return <IconLoader2 {...common} className="animate-spin text-primary" />;
    case "done":
      return lookup ? <IconSearch {...common} className="text-ink-faint" /> : <IconCheck {...common} className="text-status-ok" />;
    case "error":
      return <IconAlertTriangle {...common} className="text-status-error" />;
    case "denied":
      return <IconBan {...common} className="text-ink-faint" />;
    case "needs_approval":
      return <IconShieldCheck {...common} className="text-status-busy" />;
  }
}

/** A link to what the call acts on: the service or the project page. */
function TargetLink({ target }: { target: ai.AiToolTarget | undefined }) {
  if (!target?.projectId || !target.name) return null;
  const label = `${t("assistant.card.open")} ${target.name}`;
  const className =
    "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-chip text-ink-faint transition-interactive hover:bg-muted hover:text-foreground";
  return target.type === "service" ? (
    <Link
      to="/p/$projectId/s/$serviceId"
      params={{ projectId: target.projectId, serviceId: target.id }}
      aria-label={label}
      className={className}
    >
      <IconArrowUpRight size={14} stroke={1.9} aria-hidden="true" />
    </Link>
  ) : (
    <Link to="/p/$projectId" params={{ projectId: target.projectId }} aria-label={label} className={className}>
      <IconArrowUpRight size={14} stroke={1.9} aria-hidden="true" />
    </Link>
  );
}

/** "in acme-shop" under a service's card; nothing for a project (its name is in the sentence). */
function where(target: ai.AiToolTarget | undefined): string | null {
  return target?.type === "service" && target.projectName ? t("assistant.card.inProject", { project: target.projectName }) : null;
}

/** The redacted input and the short result, behind Details. */
function Details({ part, open }: { part: ToolCall; open: boolean }) {
  if (!open) return null;
  const input = JSON.stringify(part.input ?? {}, null, 2);
  return (
    <div className="flex flex-col gap-2 pt-1">
      {input !== "{}" && <CodeBlock title={t("assistant.card.input")} code={input} maxHeight={200} className="text-[12px]" />}
      {part.resultPreview && (
        <CodeBlock title={t("assistant.card.result")} code={part.resultPreview} maxHeight={200} className="text-[12px]" />
      )}
    </div>
  );
}

function DetailsToggle({ open, onToggle, controls }: { open: boolean; onToggle(): void; controls: string }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? t("assistant.card.hideDetails") : t("assistant.card.details")}
      onClick={onToggle}
      className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent text-ink-faint transition-interactive hover:bg-muted hover:text-foreground"
    >
      <IconChevronDown
        size={14}
        stroke={1.9}
        aria-hidden="true"
        className={cn("transition-transform duration-200", open && "rotate-180")}
      />
    </button>
  );
}

function CardFrame({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <section
      aria-label={label}
      data-slot="action-card"
      className={cn("flex flex-col gap-1.5 rounded-control bg-raised px-3 py-2.5", className)}
    >
      {children}
    </section>
  );
}

function ActionCard({ part }: { part: ToolCall }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const lookup = isLookup(part.opId);
  const sentence = actionPhrase(part.opId, phaseOf[part.status], part.target?.name || undefined);
  const place = where(part.target);
  return (
    <CardFrame label={sentence}>
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon status={part.status} lookup={lookup} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate text-[13px]", lookup ? "text-ink-strong" : "font-medium text-foreground")}>{sentence}</span>
          {place && <span className="truncate text-[12px] text-muted-foreground">{place}</span>}
        </div>
        {part.auto && (
          <Chip tone="violet" className="px-1.5 py-px text-[11px]">
            <IconBolt size={11} stroke={2} aria-hidden="true" />
            {t("assistant.autoRan")}
          </Chip>
        )}
        {!lookup && (
          <Chip tone={statusTones[part.status]} className="px-1.5 py-px text-[11px]">
            {t(`assistant.card.statuses.${part.status}`)}
          </Chip>
        )}
        <TargetLink target={part.target} />
        <DetailsToggle open={open} onToggle={() => setOpen(!open)} controls={detailsId} />
      </div>
      {part.status === "error" && part.resultPreview && !open && (
        <p className="m-0 line-clamp-2 text-[12px] text-chip-red-fg">{part.resultPreview}</p>
      )}
      <div id={detailsId}>
        <Details part={part} open={open} />
      </div>
    </CardFrame>
  );
}

const decidedTones = { pending: "amber", approved: "blue", rejected: "gray", expired: "gray", executed: "green", failed: "red" } as const;

function ApprovalCard({ part, approvalId }: { part: ToolCall; approvalId: string }) {
  const query = useOp(approvals.get, { approvalId }, { retry: false });
  const approval = query.data;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const detailsId = useId();
  const refresh = [approvals.list, approvals.get];
  const approve = useSettingsMutation(approvals.approve, { invalidates: refresh, failure: false });
  const deny = useSettingsMutation(approvals.deny, { invalidates: refresh, failure: false });

  const name = part.target?.name || approval?.target?.name || undefined;
  const question = actionPhrase(part.opId, "ask", name);
  const destructive = approval ? approval.opKind === "destructive" : isDestructive(part.opId);
  const pending = approval?.status === "pending" && part.status === "needs_approval";
  const warning = pending ? approval?.warning : undefined;
  // Both ask before they run, with a red button.
  const careful = destructive || !!warning;
  const busy = approve.isPending || deny.isPending;
  const place = where(part.target);
  const error = approve.error ?? deny.error;

  return (
    <CardFrame label={question} className={cn(pending && "bg-highlight")}>
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-px">
          <StatusIcon status={part.status} lookup={false} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-medium text-foreground">{question}</span>
          {approval ? (
            <span className="text-[12px] text-muted-foreground">
              {approval.status === "pending" || !approval.decidedBy
                ? t("assistant.card.askedBy", { when: formatRelative(approval.createdAt), person: approval.requestedBy.userName })
                : t("assistant.card.decided", {
                    status: t(`approvals.statuses.${approval.status}`),
                    person: approval.decidedBy.name,
                    when: approval.decidedAt ? formatRelative(approval.decidedAt) : "",
                  })}
              {/* The project name never breaks inside. */}
              {place && <span className="whitespace-nowrap"> · {place}</span>}
            </span>
          ) : query.isPending ? (
            <SkeletonText className="w-40 text-[12px]" />
          ) : null}
        </div>
        {destructive && pending && (
          <Chip tone="red" className="px-1.5 py-px text-[11px]">
            {t("assistant.card.destructive")}
          </Chip>
        )}
        {warning && <ApprovalWarningChip warning={warning} className="px-1.5 py-px text-[11px]" />}
        {/* While it waits, Approve and Reject say so; after, the chip says how it went. */}
        {approval && !pending && (
          <Chip tone={decidedTones[approval.status]} className="px-1.5 py-px text-[11px]">
            {t(`approvals.statuses.${approval.status}`)}
          </Chip>
        )}
        <TargetLink target={part.target} />
        <DetailsToggle open={open} onToggle={() => setOpen(!open)} controls={detailsId} />
      </div>
      {warning && <ApprovalWarningNote warning={warning} name={name ?? ""} className="px-2.5 py-2 text-[12px]" />}
      {approval?.status === "expired" && <p className="m-0 text-[12px] text-muted-foreground">{t("assistant.card.expired")}</p>}
      {approval?.error && <p className="m-0 line-clamp-2 text-[12px] text-chip-red-fg">{approval.error}</p>}
      {error && (
        <p role="alert" className="m-0 text-[12px] text-chip-red-fg">
          {t("assistant.card.approveFailed")}: {error.code === "FORBIDDEN" ? t("assistant.card.forbidden") : error.message}
        </p>
      )}
      {pending && (
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button size="sm" disabled={busy} onClick={() => deny.mutate({ approvalId })}>
            {t("assistant.card.reject")}
          </Button>
          <Button
            size="sm"
            variant={careful ? "destructive" : "primary"}
            disabled={busy}
            onClick={() => (careful ? setConfirming(true) : approve.mutate({ approvalId }))}
          >
            {approve.isPending ? t("assistant.card.approving") : t("assistant.card.approve")}
          </Button>
        </div>
      )}
      <div id={detailsId}>
        <Details part={part} open={open} />
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={question}
        description={destructive ? t("assistant.card.confirmDestructive") : t("approvals.plain.confirm")}
        confirmLabel={t("assistant.card.approve")}
        destructive
        onConfirm={() => {
          setConfirming(false);
          approve.mutate({ approvalId });
        }}
      >
        {warning && !destructive && <ApprovalWarningNote warning={warning} name={name ?? ""} className="text-[12.5px]" />}
      </ConfirmDialog>
    </CardFrame>
  );
}
