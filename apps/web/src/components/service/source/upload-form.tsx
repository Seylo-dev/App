// Upload sources: each uploaded .tar.gz becomes a deploy. The archive goes
// to POST /api/uploads/services/<id> (same origin, session cookie), which
// stores it, switches the source to upload and queues the deploy.

import { deployments, isOpErrorCode, OpError, services } from "@seylo/ops";
import { Button } from "@seylo/ui/components/button";
import { toast } from "@seylo/ui/components/toast";
import { IconUpload } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { formatBytes } from "../../../lib/format";
import { sessionKeyHeaders } from "../../../lib/session-key";
import { useInvalidate } from "../invalidate";
import { MutationError } from "../op-state";
import type { ServiceDetail } from "../use-service";

const maxBytes = 512 * 1024 * 1024;

export function UploadForm({ service }: { service: ServiceDetail }) {
  const src = service.sourceConfig.type === "upload" ? service.sourceConfig : null;
  const invalidate = useInvalidate();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);

  const upload = async (file: File) => {
    setError(null);
    if (file.size > maxBytes) {
      setError(new OpError("BAD_REQUEST", t("serviceSource.upload.tooLarge", { size: formatBytes(maxBytes) })));
      return;
    }
    setProgress(0);
    try {
      await postArchive(`/api/uploads/services/${encodeURIComponent(service.id)}`, file, setProgress);
      invalidate(services.get, deployments.list);
      toast.success(t("serviceSource.upload.started", { file: file.name }));
    } catch (e) {
      setError(e);
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[13px] text-ink-strong">
        {src?.fileName ? t("serviceSource.upload.last", { file: src.fileName }) : t("serviceSource.upload.description")}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          type="file"
          accept=".tar.gz,.tgz,application/gzip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <Button onClick={() => input.current?.click()} disabled={progress !== null}>
          <IconUpload size={15} aria-hidden="true" />
          {progress !== null ? t("serviceSource.upload.uploading", { percent: progress }) : t("serviceSource.upload.choose")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("serviceSource.upload.limit", { size: formatBytes(maxBytes) })}</span>
      </div>
      <MutationError error={error} />
    </div>
  );
}

/** POSTs the archive with progress; panel errors come back as OpError. */
function postArchive(url: string, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("x-file-name", file.name);
    for (const [name, value] of Object.entries(sessionKeyHeaders())) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status < 300) return resolve();
      try {
        const body = JSON.parse(xhr.responseText) as { error?: { code?: string; message?: string } };
        const code = body.error?.code;
        reject(new OpError(isOpErrorCode(code) ? code : "INTERNAL", body.error?.message ?? xhr.statusText));
      } catch {
        reject(new OpError("INTERNAL", xhr.statusText || t("serviceSource.upload.failed")));
      }
    };
    xhr.onerror = () => reject(new OpError("UNAVAILABLE", t("serviceSource.upload.failed")));
    xhr.send(file);
  });
}
