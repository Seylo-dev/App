// Import, step 1: pick the .zip (and the project when none was given), see
// what it is, type its passphrase when it is encrypted. Continue sends the
// small entries to serviceTransfer.importBegin, which checks and opens
// them; nothing is created yet.

import { serviceTransfer } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Input } from "@seylo/ui/components/input";
import { KeyValue } from "@seylo/ui/components/key-value";
import { SectionCard } from "@seylo/ui/components/section-card";
import { IconFileZip } from "@tabler/icons-react";
import { type FormEvent, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { ProjectPicker } from "../pickers";
import { Field } from "../service/field";
import { formatBytes, formatDateTime } from "../service/format";
import { type ExportFile, ExportFileError, readExport } from "./read-export";

export type ImportPreview = (typeof serviceTransfer.importBegin.output)["static"];

export function FileStep({
  projectId: fixed,
  onBegun,
}: {
  projectId?: string;
  onBegun: (preview: ImportPreview, file: ExportFile) => void;
}) {
  const [projectId, setProjectId] = useState(fixed ?? "");
  const [file, setFile] = useState<ExportFile | null>(null);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const begin = useOpMutation(serviceTransfer.importBegin, {
    onSuccess: (preview) => {
      if (file) onBegun(preview, file);
    },
  });

  const pick = async (picked: File | undefined) => {
    if (!picked) return;
    setFile(null);
    setProblem(null);
    setPassphrase("");
    begin.reset();
    setReading(true);
    try {
      setFile(await readExport(picked));
    } catch (error) {
      setProblem(error instanceof ExportFileError ? error.message : t("common.unknownError"));
    } finally {
      setReading(false);
    }
  };

  const encrypted = file?.manifest.secrets === "encrypted";
  const service = file?.manifest.services[0];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!file || !projectId) return;
    begin.mutate({
      projectId,
      manifest: file.manifestText,
      ...(file.signature ? { signature: file.signature } : {}),
      ...(file.secretsEnc ? { secretsEnc: file.secretsEnc } : {}),
      ...(file.services.length ? { services: file.services } : {}),
      ...(encrypted ? { passphrase } : {}),
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <SectionCard title={t("serviceTransfer.import.file")}>
        <div className="flex flex-col gap-4">
          {!fixed && (
            <Field label={t("serviceTransfer.import.project")} htmlFor="import-project" className="max-w-[440px]">
              <ProjectPicker id="import-project" value={projectId} onChange={setProjectId} />
            </Field>
          )}
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void pick(e.dataTransfer.files[0]);
            }}
            className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-card border-2 border-dashed px-6 py-8 text-center transition-colors duration-200 ${dragging ? "border-primary bg-accent" : "border-divider hover:bg-muted"}`}
          >
            <IconFileZip size={26} stroke={1.6} className="text-ink-faint" aria-hidden="true" />
            <span className="text-[13.5px] font-medium text-foreground">{t("serviceTransfer.import.pick")}</span>
            <span className="text-[12.5px] text-muted-foreground">{t("serviceTransfer.import.drop")}</span>
            <input
              ref={input}
              type="file"
              accept=".zip,application/zip"
              aria-label={t("serviceTransfer.import.pick")}
              className="sr-only"
              onChange={(e) => void pick(e.target.files?.[0] ?? undefined)}
            />
          </label>
          {reading && <p className="m-0 text-[13px] text-muted-foreground">{t("serviceTransfer.import.reading")}</p>}
          {problem && (
            <Alert tone="danger" role="alert">
              {t("serviceTransfer.import.unreadable", { reason: problem })}
            </Alert>
          )}
          {file && service && (
            <KeyValue
              items={[
                { label: t("serviceTransfer.import.summary.service"), value: <span className="font-mono">{service.name}</span> },
                { label: t("serviceTransfer.import.summary.kind"), value: service.kind },
                { label: t("serviceTransfer.import.summary.size"), value: formatBytes(file.size) },
                { label: t("serviceTransfer.import.summary.from"), value: file.manifest.panel?.version ?? "" },
                { label: t("serviceTransfer.import.summary.exported"), value: formatDateTime(file.manifest.exportedAt) },
                {
                  label: t("serviceTransfer.import.summary.secrets"),
                  value: encrypted ? t("serviceTransfer.import.summary.encrypted") : t("serviceTransfer.import.summary.omitted"),
                },
              ]}
            />
          )}
          {file && encrypted && (
            <Field
              label={t("serviceTransfer.import.passphrase")}
              htmlFor="import-passphrase"
              hint={t("serviceTransfer.import.passphraseHint")}
              className="max-w-[440px]"
            >
              <Input
                id="import-passphrase"
                type="password"
                autoComplete="off"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </Field>
          )}
          {begin.error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {errorMessage(begin.error, t("common.unknownError"))}
            </p>
          )}
        </div>
      </SectionCard>
      <div className="flex justify-end gap-2">
        <Button type="submit" variant="primary" disabled={!file || !projectId || (encrypted && passphrase === "") || begin.isPending}>
          {begin.isPending ? t("serviceTransfer.import.checking") : t("serviceTransfer.import.continue")}
        </Button>
      </div>
    </form>
  );
}
