// Import, step 3: the uploaded archive goes up in parts of at most 32 MiB
// (serviceTransfer.uploadTicket for each, then a PUT with progress), so a
// proxy's body limit or a dropped connection costs one part, not the whole
// archive. Then: open the service, and the new deploy trigger URL once.

import { isOpErrorCode, OpError, serviceTransfer } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { CopyField } from "@seylo/ui/components/copy-field";
import { Progress } from "@seylo/ui/components/progress";
import { SectionCard } from "@seylo/ui/components/section-card";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { formatBytes } from "../service/format";
import { archiveBytes, type ExportFile } from "./read-export";
import type { ImportResult } from "./review-step";

/** PUTs one part with progress; rejects with the panel's error. */
function putPart(url: string, body: Blob, onProgress: (sent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let error = new OpError("INTERNAL", t("common.unknownError"));
      try {
        const body = (JSON.parse(xhr.responseText) as { error?: { code?: string; message?: string } }).error;
        if (body?.message) error = new OpError(isOpErrorCode(body.code) ? body.code : "BAD_REQUEST", body.message);
      } catch {
        // not JSON
      }
      reject(error);
    };
    xhr.onerror = () => reject(new OpError("UNAVAILABLE", t("common.unknownError")));
    xhr.send(body);
  });
}

export function UploadStep({ result, file, deployWhenReady }: { result: ImportResult; file: ExportFile; deployWhenReady: boolean }) {
  const navigate = useNavigate();
  const ticket = useOpMutation(serviceTransfer.uploadTicket);
  const discard = useOpMutation(serviceTransfer.discardImport);
  const [sent, setSent] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [done, setDone] = useState(result.pending.length === 0);
  const running = useRef(false);
  const pending = result.pending[0];
  const total = pending?.sizeBytes ?? 0;
  const service = result.service;

  const upload = useCallback(async () => {
    if (!pending || !file.upload || running.current) return;
    running.current = true;
    setFailed(null);
    setSent(0);
    try {
      const bytes = await archiveBytes(file, file.upload);
      const part = serviceTransfer.uploadPartBytes;
      for (let offset = 0; offset < bytes.size; offset += part) {
        const link = await ticket.mutateAsync({ projectId: service.projectId, importId: result.importId, entry: pending.entry, offset });
        await putPart(link.url, bytes.slice(offset, offset + part), (n) => setSent(offset + n));
      }
      setSent(bytes.size);
      setDone(true);
    } catch (error) {
      setFailed(errorMessage(error, t("common.unknownError")));
    } finally {
      running.current = false;
    }
  }, [file, pending, result.importId, service.projectId, ticket]);

  // Once, when the step shows; Retry starts it again.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void upload();
  }, [upload]);

  // Leaving mid-upload loses the parts not sent yet.
  useEffect(() => {
    if (done) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = t("serviceTransfer.upload.leave");
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [done]);

  const openService = () =>
    void navigate({ to: "/p/$projectId/s/$serviceId", params: { projectId: service.projectId, serviceId: service.id } });

  if (!done) {
    return (
      <SectionCard title={t("serviceTransfer.upload.title")}>
        <div className="flex flex-col gap-3">
          <Progress value={total ? (sent / total) * 100 : null} aria-label={t("serviceTransfer.upload.title")} />
          <span className="text-[13px] text-muted-foreground">
            {t("serviceTransfer.upload.progress", { done: formatBytes(sent), total: formatBytes(total) })}
          </span>
          {failed && (
            <Alert tone="danger" role="alert" action={<Button onClick={() => void upload()}>{t("serviceTransfer.upload.retry")}</Button>}>
              {t("serviceTransfer.upload.failed", { reason: failed })}
            </Alert>
          )}
          {failed && (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                onClick={() =>
                  discard.mutate(
                    { projectId: service.projectId, importId: result.importId },
                    { onSuccess: () => void navigate({ to: "/p/$projectId", params: { projectId: service.projectId } }) },
                  )
                }
              >
                {t("serviceTransfer.done.discard")}
              </Button>
            </div>
          )}
        </div>
      </SectionCard>
    );
  }

  const deploying = result.service.stopped === false || (result.pending.length > 0 && deployWhenReady);
  return (
    <SectionCard title={t("serviceTransfer.done.title", { name: service.name })}>
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="m-0 text-ink-strong">{deploying ? t("serviceTransfer.done.deploying") : t("serviceTransfer.done.stopped")}</p>
        {result.deployTrigger && (
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">{t("serviceTransfer.done.trigger")}</span>
            <CopyField value={result.deployTrigger.url} />
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="primary" onClick={openService}>
            {t("serviceTransfer.done.open", { name: service.name })}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
