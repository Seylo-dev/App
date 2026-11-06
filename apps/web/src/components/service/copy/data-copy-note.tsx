// A clone's data copy under the service header: waiting, copying (with
// the bytes so far), failed with the reason. A finished copy says nothing;
// the service page is the clone's own from then on.

import { Alert } from "@seylo/ui/components/alert";
import { t } from "../../../i18n/t";
import { formatBytes } from "../format";
import type { ServiceDetail } from "../use-service";

export function DataCopyNote({ service }: { service: ServiceDetail }) {
  const copy = service.dataCopy;
  if (!copy || copy.status === "done") return null;
  if (copy.status === "failed") {
    return (
      <Alert tone="danger">
        {t("serviceCopy.dataCopy.failed", { name: copy.fromName, error: copy.error ?? t("common.unknownError") })}
      </Alert>
    );
  }
  return (
    <Alert tone="info" aria-live="polite">
      {copy.status === "queued"
        ? t("serviceCopy.dataCopy.queued", { name: copy.fromName })
        : t("serviceCopy.dataCopy.copying", { name: copy.fromName, size: formatBytes(copy.bytesCopied) })}
    </Alert>
  );
}
