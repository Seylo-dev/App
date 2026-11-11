// Going on with an import whose page was closed while its data went up
// (the service page's note links here with ?resume=<importId>): pick the
// same .zip again. Its manifest must hash to what the panel kept
// (serviceTransfer.getImport's manifestSha256) before anything is sent;
// then the upload step goes on with what is still missing.

import { services as serviceOps, serviceTransfer } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { SectionCard } from "@seylo/ui/components/section-card";
import { useState } from "react";
import { t } from "../../i18n/t";
import { OpErrorNote, retryOp } from "../service/op-state";
import { type ExportFile, ExportFileError, readExport } from "./read-export";
import type { ImportResult } from "./review-step";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ResumeStep({
  projectId,
  importId,
  onReady,
}: {
  projectId: string;
  importId: string;
  onReady: (result: ImportResult, file: ExportFile, deployWhenReady: boolean) => void;
}) {
  const state = useOp(serviceTransfer.getImport, { projectId, importId }, { retry: retryOp });
  const serviceId = state.data?.serviceId ?? "";
  const service = useOp(serviceOps.get, { serviceId }, { enabled: serviceId !== "", retry: retryOp });
  const [problem, setProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const pick = async (picked: File | undefined) => {
    if (!picked || !state.data || !service.data) return;
    setProblem(null);
    setReading(true);
    try {
      const file = await readExport(picked);
      if ((await sha256Hex(file.manifestText)) !== state.data.manifestSha256) {
        setProblem(t("serviceTransfer.resume.otherFile"));
        return;
      }
      const pending = state.data.entries
        .filter((e) => e.status !== "done")
        .map((e) => ({ entry: e.path, sizeBytes: e.size, kind: e.kind, volume: e.volume }));
      onReady({ service: service.data, importId, pending, deployTrigger: null, skipped: [] }, file, state.data.deployWhenReady);
    } catch (error) {
      setProblem(error instanceof ExportFileError ? error.message : t("common.unknownError"));
    } finally {
      setReading(false);
    }
  };

  if (state.isError) return <OpErrorNote error={state.error} />;
  if (service.isError) return <OpErrorNote error={service.error} />;
  const waiting = state.data?.status === "receiving";
  return (
    <SectionCard title={t("serviceTransfer.resume.title", { name: service.data?.name ?? "" })}>
      <div className="flex flex-col gap-3 text-[13px]">
        {state.data && !waiting ? (
          <Alert tone="info">{t("serviceTransfer.resume.notWaiting")}</Alert>
        ) : (
          <>
            <p className="m-0 text-muted-foreground">{t("serviceTransfer.resume.hint")}</p>
            <input
              type="file"
              accept=".zip,application/zip"
              aria-label={t("serviceTransfer.import.pick")}
              disabled={!service.data || reading}
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            {reading && <span className="text-muted-foreground">{t("serviceTransfer.import.reading")}</span>}
            {problem && (
              <Alert tone="danger" role="alert">
                {problem}
              </Alert>
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}
