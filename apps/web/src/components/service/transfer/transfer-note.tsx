// Under the service header while an export downloads the service's data
// (with Stop the export, which starts a service the download stopped), when
// such a download ended without finishing, and while an import still
// sends the service its data (with a link back to the upload).

import { serviceTransfer } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Link } from "@tanstack/react-router";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { formatBytes } from "../format";
import type { ServiceDetail } from "../use-service";

export function TransferNote({ service }: { service: ServiceDetail }) {
  const cancel = useOpMutation(serviceTransfer.cancelExport);
  const transfer = service.transfer;
  if (!transfer) return null;
  if (transfer.kind === "import") {
    return (
      <Alert
        tone="info"
        aria-live="polite"
        action={
          <Link to="/import" search={{ project: service.projectId, resume: transfer.id }} className="text-[13px] font-medium underline">
            {t("serviceTransfer.note.resume")}
          </Link>
        }
      >
        {t("serviceTransfer.note.importing", {
          name: service.name,
          done: formatBytes(transfer.bytes),
          total: formatBytes(transfer.totalBytes ?? 0),
        })}
        {transfer.error && ` ${t("serviceTransfer.note.importFailed", { error: transfer.error })}`}
      </Alert>
    );
  }
  if (transfer.volumes.length === 0 || transfer.status === "done") return null;
  if (transfer.status !== "streaming") {
    return <Alert tone="warning">{t("serviceTransfer.note.exportEnded", { error: transfer.error ?? t("common.unknownError") })}</Alert>;
  }
  return (
    <Alert
      tone="info"
      aria-live="polite"
      action={
        <Button disabled={cancel.isPending} onClick={() => cancel.mutate({ serviceId: service.id, exportId: transfer.id })}>
          {t("serviceTransfer.note.stop")}
        </Button>
      }
    >
      {transfer.stopped
        ? t("serviceTransfer.note.exportingStopped", { name: service.name, size: formatBytes(transfer.bytes) })
        : t("serviceTransfer.note.exporting", { name: service.name, size: formatBytes(transfer.bytes) })}
      {cancel.error && ` ${errorMessage(cancel.error, t("common.unknownError"))}`}
    </Alert>
  );
}
