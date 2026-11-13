// What approving a pending call weakens (Approval.warning), the same on
// the Approvals page and the assistant's approval card: a chip by its
// title, a note saying what it allows and to whom, and the words for the
// confirmation, which a red Approve button opens. In the Connection tab's
// colors: red while every IP address gets in, amber while an allow list
// limits who connects. "plainConnections" is a databases.setExposure that
// lets the database's clients in without TLS, or from more addresses.

import type { approvals } from "@seylo/ops";
import { Chip } from "@seylo/ui/components/chip";
import { cn } from "@seylo/ui/lib/utils";
import { t } from "../../i18n/t";

export type ApprovalWarning = approvals.ApprovalWarning;

export function ApprovalWarningChip({ warning, className }: { warning: ApprovalWarning; className?: string }) {
  return (
    <Chip tone={warning.openToEveryone ? "red" : "amber"} className={className}>
      {t("approvals.plain.chip")}
    </Chip>
  );
}

/** What approving it allows (`name` is the database, empty when unknown) and who gets in. */
export function ApprovalWarningNote({ warning, name, className }: { warning: ApprovalWarning; name: string; className?: string }) {
  const database = name || t("approvals.plain.theDatabase");
  return (
    <div
      role="note"
      data-slot="approval-warning"
      className={cn(
        "flex flex-col gap-1 rounded-control px-3 py-2.5 leading-normal",
        warning.openToEveryone ? "bg-chip-red-bg text-chip-red-fg" : "bg-chip-amber-bg text-chip-amber-fg",
        className,
      )}
    >
      <p className="m-0">{t(`approvals.plain.${warning.change}`, { name: database })}</p>
      <p className={cn("m-0", warning.openToEveryone && "font-medium")}>
        {warning.openToEveryone
          ? t("approvals.plain.openToEveryone")
          : t("approvals.plain.limited", { cidrs: warning.allowedCidrs.join(", ") })}
      </p>
    </div>
  );
}
