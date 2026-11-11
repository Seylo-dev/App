// Import, step 3: what the file still has to send goes up, one entry after
// the other: the uploaded archive, then each volume's data. Every entry
// goes in parts of at most 32 MiB (serviceTransfer.uploadTicket for each,
// then a PUT with progress), so a proxy's body limit or a dropped
// connection costs one part, not the whole entry; Retry asks the panel
// what it has (serviceTransfer.getImport) and goes on from there. Then:
// open the service, and the new deploy trigger URL once.

import { isOpErrorCode, OpError, serviceTransfer } from "@seylo/ops";
import { useOpClient, useOpMutation } from "@seylo/ops/react";
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
import { type ExportFile, entryBytes, entryOf } from "./read-export";
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

type Pending = ImportResult["pending"][number];

interface Row extends Pending {
  sent: number;
  state: "waiting" | "uploading" | "done" | "failed";
}

export function UploadStep({ result, file, deployWhenReady }: { result: ImportResult; file: ExportFile; deployWhenReady: boolean }) {
  const navigate = useNavigate();
  const client = useOpClient();
  const discard = useOpMutation(serviceTransfer.discardImport);
  const [rows, setRows] = useState<Row[]>(() => result.pending.map((p) => ({ ...p, sent: 0, state: "waiting" })));
  const [failed, setFailed] = useState<string | null>(null);
  const running = useRef(false);
  const service = result.service;
  const projectId = service.projectId;
  const importId = result.importId;
  const done = rows.every((r) => r.state === "done");
  const total = rows.reduce((n, r) => n + r.sizeBytes, 0);
  const sent = rows.reduce((n, r) => n + (r.state === "done" ? r.sizeBytes : r.sent), 0);

  const upload = useCallback(async () => {
    const update = (entry: string, change: Partial<Row>) => setRows((all) => all.map((r) => (r.entry === entry ? { ...r, ...change } : r)));
    if (running.current) return;
    running.current = true;
    setFailed(null);
    try {
      // Where the panel stands: a reload or a broken part goes on from there.
      const state = await client.call(serviceTransfer.getImport, { projectId, importId });
      for (const pending of result.pending) {
        const here = state.entries.find((e) => e.path === pending.entry);
        if (here?.status === "done") {
          update(pending.entry, { state: "done", sent: pending.sizeBytes });
          continue;
        }
        const entry = entryOf(file, pending.entry);
        if (!entry) throw new OpError("BAD_REQUEST", t("serviceTransfer.upload.missing", { entry: pending.entry }));
        const bytes = await entryBytes(file, entry);
        let offset = here?.status === "pending" ? here.received : 0;
        update(pending.entry, { state: "uploading", sent: offset });
        const part = serviceTransfer.uploadPartBytes;
        while (offset < bytes.size) {
          const start = offset;
          const link = await client.call(serviceTransfer.uploadTicket, { projectId, importId, entry: pending.entry, offset: start });
          await putPart(link.url, bytes.slice(start, start + part), (n) => update(pending.entry, { sent: start + n }));
          offset = Math.min(bytes.size, start + part);
        }
        update(pending.entry, { state: "done", sent: bytes.size });
      }
    } catch (error) {
      setRows((all) => all.map((r) => (r.state === "uploading" ? { ...r, state: "failed" } : r)));
      setFailed(errorMessage(error, t("common.unknownError")));
    } finally {
      running.current = false;
    }
  }, [client, file, importId, projectId, result.pending]);

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
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" aria-label={t("serviceTransfer.upload.entries")}>
            {rows.map((r) => (
              <li
                key={r.entry}
                className="flex flex-wrap items-center justify-between gap-2"
                data-testid={`upload-${r.volume ?? "archive"}`}
              >
                <span className="text-ink-strong">
                  {r.kind === "volume" ? t("serviceTransfer.upload.volume", { name: r.volume ?? "" }) : t("serviceTransfer.upload.archive")}
                </span>
                <span className="text-muted-foreground">
                  {t(`serviceTransfer.upload.state.${r.state}`, {
                    done: formatBytes(r.state === "done" ? r.sizeBytes : r.sent),
                    total: formatBytes(r.sizeBytes),
                  })}
                </span>
              </li>
            ))}
          </ul>
          {failed && (
            <Alert tone="danger" role="alert" action={<Button onClick={() => void upload()}>{t("serviceTransfer.upload.retry")}</Button>}>
              {t("serviceTransfer.upload.failed", { reason: failed })}
            </Alert>
          )}
          {failed && discard.error && (
            <Alert tone="danger" role="alert">
              {errorMessage(discard.error, t("common.unknownError"))}
            </Alert>
          )}
          {failed && (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                disabled={discard.isPending}
                onClick={() =>
                  discard.mutate(
                    { projectId, importId },
                    { onSuccess: () => void navigate({ to: "/p/$projectId", params: { projectId } }) },
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
