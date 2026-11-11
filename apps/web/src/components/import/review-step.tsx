// Import, step 2: what the import creates and the choices it needs. Every
// change goes to serviceTransfer.setChoices, whose answer is the new
// preview (blockers, open choices, warnings); basic auth passwords stay in
// this page and go with serviceTransfer.import only. Import creates the
// service, stopped.

import { serviceTransfer } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { isReauthCancelled } from "../../lib/reauth";
import { CheckLabel, Field, SwitchLabel } from "../service/field";
import { formatBytes } from "../service/format";
import type { ImportPreview } from "./file-step";

type Choices = ImportPreview["choices"];
export type ImportResult = (typeof serviceTransfer.importService.output)["static"];

const key = (d: { host: string; pathPrefix: string }) => `${d.host}${d.pathPrefix}`;

export function ReviewStep({
  preview: initial,
  onImported,
}: {
  preview: ImportPreview;
  onImported: (result: ImportResult, choices: Choices) => void;
}) {
  const [preview, setPreview] = useState(initial);
  const [name, setName] = useState(initial.choices.name ?? "");
  const [passwords, setPasswords] = useState<Record<string, Record<string, string>>>({});
  const ref = { projectId: preview.projectId, importId: preview.importId };
  const save = useOpMutation(serviceTransfer.setChoices, { onSuccess: setPreview });
  const run = useOpMutation(serviceTransfer.importService, { onSuccess: (result) => onImported(result, preview.choices) });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const choose = (change: Partial<Choices>) => save.mutate({ ...ref, choices: { ...preview.choices, ...change } });
  // The name is saved once typing pauses.
  const typeName = (next: string) => {
    setName(next);
    if (timer.current) clearTimeout(timer.current);
    if (next === (preview.choices.name ?? "") || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(next)) return;
    timer.current = setTimeout(() => choose({ name: next }), 400);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const needPasswords = preview.domains.filter((d) => d.status === "needsPassword" && d.action === "add");
  const missingPassword = needPasswords.some((d) => d.basicAuthUsers.some((u) => (passwords[key(d)]?.[u] ?? "").length < 8));
  const open = preview.blockers.length + preview.needs.length;
  const submit = () =>
    run.mutate({
      ...ref,
      ...(needPasswords.length
        ? {
            passwords: needPasswords.flatMap((d) =>
              d.basicAuthUsers.map((username) => ({
                host: d.host,
                pathPrefix: d.pathPrefix,
                username,
                password: passwords[key(d)]?.[username] ?? "",
              })),
            ),
          }
        : {}),
    });
  const repo =
    preview.service.source.type !== "image" && preview.service.source.type !== "none" && preview.service.source.type !== "database";
  const runError = run.error && !isReauthCancelled(run.error) ? run.error : null;

  return (
    <div className="flex flex-col gap-4">
      {open > 0 ? (
        <Alert tone="warning" title={t("serviceTransfer.review.needsYou", { count: open })}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {[...preview.blockers, ...preview.needs].map((issue) => (
              <li key={`${issue.reason}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </Alert>
      ) : (
        <Alert tone="success">{t("serviceTransfer.review.ready")}</Alert>
      )}

      <SectionCard title={preview.service.name} description={`${preview.service.kind} · ${preview.service.source.label}`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("serviceTransfer.review.name")} htmlFor="import-name">
            <Input
              id="import-name"
              className="font-mono"
              value={name}
              maxLength={40}
              onChange={(e) => typeName(e.target.value.toLowerCase())}
            />
          </Field>
          <Field label={t("serviceTransfer.review.node")} htmlFor="import-node">
            <Select value={preview.choices.nodeId ?? ""} onValueChange={(nodeId) => choose({ nodeId })}>
              <SelectTrigger id="import-node">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {preview.nodes.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.name}
                    {!n.online && <span className="text-muted-foreground"> ({t("serviceTransfer.review.offline")})</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </SectionCard>

      <SectionCard title={t("serviceTransfer.review.source")}>
        <div className="flex flex-col gap-3">
          {preview.source.access.options.length > 0 && (
            <Field
              label={t("serviceTransfer.review.readWith")}
              htmlFor="import-access"
              hint={preview.source.access.wanted ? t("serviceTransfer.review.wanted", { wanted: preview.source.access.wanted }) : undefined}
              className="max-w-[520px]"
            >
              <Select
                value={preview.source.access.picked ? `${preview.source.access.picked.kind}:${preview.source.access.picked.id ?? ""}` : ""}
                onValueChange={(value) => {
                  const [kind, id] = value.split(":");
                  choose({ sourceAccess: { kind: kind as NonNullable<Choices["sourceAccess"]>["kind"], ...(id ? { id } : {}) } });
                }}
              >
                <SelectTrigger id="import-access">
                  <SelectValue placeholder={t("serviceTransfer.review.readWith")} />
                </SelectTrigger>
                <SelectContent>
                  {preview.source.access.options.map((o) => (
                    <SelectItem key={`${o.kind}:${o.id ?? ""}`} value={`${o.kind}:${o.id ?? ""}`}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {repo && preview.source.commitSha && (
            <Field label={t("serviceTransfer.review.commit")} htmlFor="import-commit" className="max-w-[520px]">
              <Select value={preview.choices.commit ?? "live"} onValueChange={(commit) => choose({ commit: commit as "live" | "head" })}>
                <SelectTrigger id="import-commit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="live">
                    {t("serviceTransfer.review.commitLive", { sha: preview.source.commitSha.slice(0, 7) })}
                  </SelectItem>
                  <SelectItem value="head">{t("serviceTransfer.review.commitHead")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          {preview.source.imageDigest && (
            <CheckLabel checked={preview.choices.pinDigest === true} onCheckedChange={(v) => choose({ pinDigest: v === true })}>
              {t("serviceTransfer.review.pinDigest", { digest: preview.source.imageDigest.slice(0, 19) })}
            </CheckLabel>
          )}
          {repo && (
            <SwitchLabel checked={preview.choices.deployOnPush === true} onCheckedChange={(v) => choose({ deployOnPush: v })}>
              {t("serviceTransfer.review.deployOnPush")}
            </SwitchLabel>
          )}
          <CheckLabel checked={preview.choices.deployWhenReady === true} onCheckedChange={(v) => choose({ deployWhenReady: v === true })}>
            {t("serviceTransfer.review.deployWhenReady")}
          </CheckLabel>
        </div>
      </SectionCard>

      <SectionCard title={t("serviceTransfer.review.env")}>
        <div className="flex flex-col gap-2 text-[13px]">
          <span className="text-ink-strong">
            {t("serviceTransfer.review.keys", { count: preview.env.keys.length })}
            {preview.env.empty && preview.env.keys.length > 0 && (
              <span className="text-muted-foreground"> ({t("serviceTransfer.review.noValues")})</span>
            )}
          </span>
          {preview.env.references.length > 0 && (
            <Lines title={t("serviceTransfer.review.renamed", { name: preview.choices.name ?? "" })}>
              {preview.env.references.map((r) => (
                <li key={`${r.key}:${r.target}`}>
                  <span className="font-mono">{r.key}</span> <span className="font-mono">{r.target}</span>
                </li>
              ))}
            </Lines>
          )}
          {preview.env.readsFrom.length > 0 && (
            <Lines title={t("serviceTransfer.review.readsFrom")}>
              {preview.env.readsFrom.map((r) => (
                <li key={`${r.key}:${r.service}`}>
                  <span className="font-mono">{r.key}</span> → <span className="font-mono">{r.service}</span> ({r.kind})
                </li>
              ))}
            </Lines>
          )}
          {preview.env.shared.length > 0 && (
            <div className="flex flex-col gap-2">
              <Lines title={t("serviceTransfer.review.shared")}>
                {preview.env.shared.map((s) => (
                  <li key={s.name}>
                    <span className="font-mono">{s.name}</span>{" "}
                    <span className="text-muted-foreground">{t(`serviceTransfer.review.sharedState.${s.state}`)}</span>
                  </li>
                ))}
              </Lines>
              <Select
                value={preview.choices.sharedVariables ?? "addMissing"}
                onValueChange={(v) => choose({ sharedVariables: v as NonNullable<Choices["sharedVariables"]> })}
              >
                <SelectTrigger aria-label={t("serviceTransfer.review.shared")} className="max-w-[320px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["addMissing", "overwrite", "skip"] as const).map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(`serviceTransfer.review.sharedChoice.${v}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard title={t("serviceTransfer.review.domains")}>
        <div className="flex flex-col gap-3">
          {preview.domains.length === 0 && <p className="m-0 text-[13px] text-muted-foreground">{t("serviceTransfer.review.noDomains")}</p>}
          {preview.domains.map((d) => {
            const forced = d.status === "auto" || d.status === "invalid" || d.status === "usedHere" || d.status === "usedHidden";
            return (
              <div key={key(d)} className="flex flex-col gap-2 rounded-control bg-raised p-3" data-testid={`domain-${d.host}`}>
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-mono text-foreground">{d.pathPrefix === "/" ? d.host : `${d.host}${d.pathPrefix}`}</span>
                  <Chip
                    tone={
                      d.status === "free" ? "green" : d.status === "needsPassword" || d.status === "certificateDropped" ? "amber" : "gray"
                    }
                  >
                    {t(`serviceTransfer.review.status.${d.status}`)}
                  </Chip>
                  {d.primary && <Chip tone="blue">{t("serviceTransfer.review.primary")}</Chip>}
                  <span className="ml-auto">
                    <Select
                      value={d.action}
                      disabled={forced}
                      onValueChange={(action) =>
                        choose({
                          domains: preview.domains.map((x) => ({
                            host: x.host,
                            pathPrefix: x.pathPrefix,
                            action: key(x) === key(d) ? (action as "add" | "skip") : x.action,
                          })),
                        })
                      }
                    >
                      <SelectTrigger aria-label={`${d.host} ${t("serviceTransfer.review.add")}`} className="h-8 w-[100px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="add">{t("serviceTransfer.review.add")}</SelectItem>
                        <SelectItem value="skip">{t("serviceTransfer.review.skip")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </span>
                </div>
                {d.message && <p className="m-0 text-[12.5px] text-muted-foreground">{d.message}</p>}
                {d.status === "needsPassword" && d.action === "add" && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {d.basicAuthUsers.map((user) => (
                      <Field key={user} label={t("serviceTransfer.review.password", { user })} htmlFor={`pw-${key(d)}-${user}`}>
                        <Input
                          id={`pw-${key(d)}-${user}`}
                          type="password"
                          autoComplete="new-password"
                          value={passwords[key(d)]?.[user] ?? ""}
                          onChange={(e) => setPasswords((all) => ({ ...all, [key(d)]: { ...all[key(d)], [user]: e.target.value } }))}
                        />
                      </Field>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {preview.autoDomain.host ? (
            <CheckLabel checked={preview.choices.autoDomain === true} onCheckedChange={(v) => choose({ autoDomain: v === true })}>
              {t("serviceTransfer.review.autoDomain", { host: preview.autoDomain.host })}
            </CheckLabel>
          ) : (
            preview.autoDomain.reason && (
              <p className="m-0 text-[12.5px] text-muted-foreground">
                {t("serviceTransfer.review.autoDomainNo", { reason: preview.autoDomain.reason })}
              </p>
            )
          )}
        </div>
      </SectionCard>

      <SectionCard title={t("serviceTransfer.review.extras")}>
        <div className="flex flex-col gap-3 text-[13px]">
          <ChoiceRow
            label={t("serviceTransfer.review.cronJobs", { count: preview.extras.cronJobs })}
            value={preview.choices.cronJobs ?? "asInFile"}
            options={{ asInFile: t("serviceTransfer.review.asInFile"), disabled: t("serviceTransfer.review.disabled") }}
            onChange={(v) => choose({ cronJobs: v as "asInFile" | "disabled" })}
            hidden={preview.extras.cronJobs === 0 && preview.choices.cronJobs === "asInFile"}
          />
          <ChoiceRow
            label={t("serviceTransfer.review.uptimeChecks", { count: preview.extras.uptimeChecks })}
            value={preview.choices.uptimeChecks ?? "asInFile"}
            options={{
              asInFile: t("serviceTransfer.review.asInFile"),
              disabled: t("serviceTransfer.review.disabled"),
              skip: t("serviceTransfer.review.skipThem"),
            }}
            onChange={(v) => choose({ uptimeChecks: v as "asInFile" | "disabled" | "skip" })}
            hidden={preview.extras.uptimeChecks === 0 && preview.choices.uptimeChecks === "asInFile"}
          />
          {preview.extras.alerts.length > 0 && (
            <ChoiceRow
              label={`${t("serviceTransfer.review.alerts")}: ${preview.extras.alerts
                .map(
                  (a) =>
                    `${a.event} (${a.channels.map((c) => `${c.name} ${c.mapped ? t("serviceTransfer.review.mapped") : t("serviceTransfer.review.notMapped")}`).join(", ")})`,
                )
                .join("; ")}`}
              value={preview.choices.alerts ?? "skip"}
              options={{ mapByName: t("serviceTransfer.review.mapByName"), skip: t("serviceTransfer.review.skipThem") }}
              onChange={(v) => choose({ alerts: v as "mapByName" | "skip" })}
            />
          )}
          {preview.extras.backups.length > 0 && (
            <ChoiceRow
              label={`${t("serviceTransfer.review.backups")}: ${preview.extras.backups
                .map(
                  (b) =>
                    `${b.volume ?? b.target} → ${b.destination} (${b.mapped ? t("serviceTransfer.review.mapped") : t("serviceTransfer.review.notMapped")})`,
                )
                .join("; ")}`}
              value={preview.choices.backups ?? "skip"}
              options={{
                mapByName: t("serviceTransfer.review.backupsMap"),
                disabled: t("serviceTransfer.review.disabled"),
                skip: t("serviceTransfer.review.skipThem"),
              }}
              onChange={(v) => choose({ backups: v as "mapByName" | "disabled" | "skip" })}
            />
          )}
          {preview.extras.exposures.map((e) => (
            <ChoiceRow
              key={e.listenPort}
              label={`${t("serviceTransfer.review.exposures")}: ${t("serviceTransfer.review.listener", { port: e.listenPort, cidrs: e.allowedCidrs.length ? e.allowedCidrs.join(", ") : t("serviceTransfer.review.anyone") })}${e.clash ? ` (${t("serviceTransfer.review.clash")})` : ""}`}
              value={e.action}
              options={{ add: t("serviceTransfer.review.add"), skip: t("serviceTransfer.review.skip") }}
              onChange={(v) =>
                choose({
                  exposures: preview.extras.exposures.map((x) => ({
                    listenPort: x.listenPort,
                    action: (x.listenPort === e.listenPort ? v : x.action) as "add" | "skip",
                  })),
                })
              }
            />
          ))}
          {preview.extras.tunnel && <p className="m-0 text-muted-foreground">{t("serviceTransfer.review.tunnel")}</p>}
          {preview.extras.maintenance && <p className="m-0 text-muted-foreground">{t("serviceTransfer.review.maintenance")}</p>}
          {preview.extras.deployTrigger && <p className="m-0 text-muted-foreground">{t("serviceTransfer.review.deployTrigger")}</p>}
        </div>
      </SectionCard>

      {(preview.data.volumes.length > 0 || preview.data.upload) && (
        <SectionCard title={t("serviceTransfer.review.data")}>
          <div className="flex flex-col gap-1.5 text-[13px] text-ink-strong">
            {preview.data.volumes.length > 0 && (
              <span>{t("serviceTransfer.review.volumes", { volumes: preview.data.volumes.map((v) => v.name).join(", ") })}</span>
            )}
            {preview.data.upload && (
              <span>
                {t("serviceTransfer.review.upload", {
                  file: preview.data.upload.fileName,
                  size: formatBytes(preview.data.upload.sizeBytes),
                })}
              </span>
            )}
          </div>
        </SectionCard>
      )}

      {(preview.warnings.length > 0 || preview.skipped.length > 0) && (
        <SectionCard title={t("serviceTransfer.review.warnings")}>
          <div className="flex flex-col gap-3 text-[13px]">
            {preview.warnings.length > 0 && (
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-ink-strong">
                {preview.warnings.map((w) => (
                  <li key={`${w.reason}:${w.message}`}>{w.message}</li>
                ))}
              </ul>
            )}
            {preview.skipped.length > 0 && (
              <Lines title={t("serviceTransfer.review.skipped")}>
                {preview.skipped.map((s) => (
                  <li key={`${s.what}:${s.why}`}>
                    <span className="text-ink-strong">{s.what}</span>: {s.why}
                  </li>
                ))}
              </Lines>
            )}
          </div>
        </SectionCard>
      )}

      {(save.error || runError) && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {errorMessage(runError ?? save.error, t("common.unknownError"))}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="primary" onClick={submit} disabled={open > 0 || missingPassword || save.isPending || run.isPending}>
          {run.isPending ? t("serviceTransfer.review.importing") : t("serviceTransfer.review.import")}
        </Button>
      </div>
    </div>
  );
}

function Lines({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
      <span>{title}</span>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{children}</ul>
    </div>
  );
}

function ChoiceRow({
  label,
  value,
  options,
  onChange,
  hidden = false,
}: {
  label: string;
  value: string;
  options: Record<string, string>;
  onChange: (value: string) => void;
  hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="min-w-0 flex-[1_1_240px] text-ink-strong">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className="h-8 w-[240px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(options).map(([v, text]) => (
            <SelectItem key={v} value={v}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
