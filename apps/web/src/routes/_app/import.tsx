// Import a service from a .zip (New service > Import from a file): pick
// the file (components/import/file-step.tsx), review what it creates
// (review-step.tsx), then its uploaded archive and volume data go up and
// the service is there (upload-step.tsx). ?project=<id> preselects the
// project, like the templates page; with ?resume=<importId> the same file
// picked again goes on with what did not go up yet (resume-step.tsx).
// Owners and admins only; the panel says so to anyone else.

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { FileStep, type ImportPreview } from "../../components/import/file-step";
import type { ExportFile } from "../../components/import/read-export";
import { ResumeStep } from "../../components/import/resume-step";
import { type ImportResult, ReviewStep } from "../../components/import/review-step";
import { UploadStep } from "../../components/import/upload-step";
import { PageHeader } from "../../components/page-header";
import { t } from "../../i18n/t";

interface ImportSearch {
  project?: string;
  resume?: string;
}

export const Route = createFileRoute("/_app/import")({
  validateSearch: (search: Record<string, unknown>): ImportSearch => ({
    project: typeof search.project === "string" && /^[a-z0-9]{16}$/.test(search.project) ? search.project : undefined,
    resume: typeof search.resume === "string" && /^[a-z0-9]{16}$/.test(search.resume) ? search.resume : undefined,
  }),
  component: ImportPage,
});

function ImportPage() {
  const search = Route.useSearch();
  const [begun, setBegun] = useState<{ preview: ImportPreview; file: ExportFile } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [deployWhenReady, setDeployWhenReady] = useState(false);
  const [resumed, setResumed] = useState<{ result: ImportResult; file: ExportFile } | null>(null);

  return (
    <>
      <PageHeader title={t("serviceTransfer.import.title")} subtitle={t("serviceTransfer.import.subtitle")} />
      <div className="flex max-w-[880px] flex-col gap-4">
        {resumed ? (
          <UploadStep result={resumed.result} file={resumed.file} deployWhenReady={deployWhenReady} />
        ) : search.resume && search.project ? (
          <ResumeStep
            projectId={search.project}
            importId={search.resume}
            onReady={(res, file, deploy) => {
              setDeployWhenReady(deploy);
              setResumed({ result: res, file });
            }}
          />
        ) : result && begun ? (
          <UploadStep result={result} file={begun.file} deployWhenReady={deployWhenReady} />
        ) : begun ? (
          <ReviewStep
            preview={begun.preview}
            onImported={(res, choices) => {
              setDeployWhenReady(choices.deployWhenReady === true);
              setResult(res);
            }}
          />
        ) : (
          <FileStep projectId={search.project} onBegun={(preview, file) => setBegun({ preview, file })} />
        )}
      </div>
    </>
  );
}
