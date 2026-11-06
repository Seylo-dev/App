// The create form behind each "New service" choice. Every kind asks for a
// project (unless the screen already has one), a name and a node; the rest
// depends on the kind:
//   app       a Docker image or a git URL now, or nothing (set the source later)
//   cron      an image, a schedule and a command
//   database  the engine, its version (and pgvector for Postgres)
//   compose   a pasted compose file, previewed before it is created
//   box       an optional repository to clone
// After creating, the service page opens.

import { boxes, compose, databases, OpError, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input, Label } from "@seylo/ui/components/input";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { FieldSkeleton, LoadingRegion } from "@seylo/ui/components/skeleton";
import { Textarea } from "@seylo/ui/components/textarea";
import { toast } from "@seylo/ui/components/toast";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { type MessageKey, t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import type { ComposePreview } from "../../lib/types";
import { NodePicker, ProjectPicker } from "../pickers";
import { QueryError } from "../query-error";
import { type CatalogKind, KindBadge, type NewServiceKind, newServiceKinds } from "./kinds";
import { shortImage } from "./short-image";

type FormKind = Exclude<NewServiceKind, CatalogKind>;
type AppSource = "image" | "git" | "none";
type Engine = (typeof databases.DatabaseEngine)["static"];

/** note: a word on the card; notice: what to know before picking it, under the version. */
const engines: readonly { engine: Engine; label: MessageKey; tag: string; note?: MessageKey; notice?: MessageKey }[] = [
  { engine: "postgres", label: "newService.engines.postgres", tag: "PG" },
  { engine: "mysql", label: "newService.engines.mysql", tag: "MY" },
  { engine: "mariadb", label: "newService.engines.mariadb", tag: "MDB" },
  { engine: "mongo", label: "newService.engines.mongo", tag: "MGO" },
  { engine: "redis", label: "newService.engines.redis", tag: "RDS" },
  { engine: "valkey", label: "newService.engines.valkey", tag: "VK" },
  { engine: "keydb", label: "newService.engines.keydb", tag: "KDB", note: "newService.keydbNote", notice: "newService.keydbNotice" },
  { engine: "dragonfly", label: "newService.engines.dragonfly", tag: "DF" },
  { engine: "clickhouse", label: "newService.engines.clickhouse", tag: "CH" },
];

/** The Postgres image variant the form offers as a checkbox. */
const pgvector = "pgvector";

const namePattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function NewServiceDialog({
  kind,
  projectId: fixedProjectId,
  onClose,
}: {
  kind: FormKind | null;
  projectId?: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="top-[8%] max-h-[84dvh] max-w-[560px] overflow-y-auto">
        {kind && <NewServiceForm key={kind} kind={kind} fixedProjectId={fixedProjectId} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function NewServiceForm({ kind, fixedProjectId, onClose }: { kind: FormKind; fixedProjectId?: string; onClose: () => void }) {
  const navigate = useNavigate();
  const meta = newServiceKinds.find((item) => item.kind === kind);
  const [projectId, setProjectId] = useState(fixedProjectId ?? "");
  const [nodeId, setNodeId] = useState("");
  const [name, setName] = useState("");
  const [appSource, setAppSource] = useState<AppSource>("image");
  const [image, setImage] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [port, setPort] = useState("");
  const [deployNow, setDeployNow] = useState(true);
  const [schedule, setSchedule] = useState("0 * * * *");
  const [command, setCommand] = useState("");
  const [engine, setEngine] = useState<Engine>("postgres");
  // "" is the engine's newest version.
  const [version, setVersion] = useState("");
  const [withPgvector, setWithPgvector] = useState(false);
  const [yaml, setYaml] = useState("");
  const [repository, setRepository] = useState("");
  const [error, setError] = useState<unknown>(null);

  const opened = (serviceId: string, targetProjectId: string) => {
    toast.success(t("newService.created", { name }));
    onClose();
    void navigate({ to: "/p/$projectId/s/$serviceId", params: { projectId: targetProjectId, serviceId } });
  };
  const onError = (cause: unknown) => setError(cause);

  const createService = useOpMutation(services.create, { onSuccess: (s) => opened(s.id, s.projectId), onError });
  const createDatabase = useOpMutation(databases.create, { onSuccess: (d) => opened(d.serviceId, d.projectId), onError });
  const createStack = useOpMutation(compose.create, { onSuccess: (r) => opened(r.stack.id, r.stack.projectId), onError });
  const createBox = useOpMutation(boxes.create, { onSuccess: (b) => opened(b.serviceId, b.projectId), onError });
  const preview = useOpMutation(compose.preview);
  const pending = createService.isPending || createDatabase.isPending || createStack.isPending || createBox.isPending;

  const nameValid = namePattern.test(name);
  const ready =
    nameValid &&
    projectId !== "" &&
    nodeId !== "" &&
    (kind !== "app" || appSource === "none" || (appSource === "image" ? image.trim() !== "" : gitUrl.trim() !== "")) &&
    (kind !== "cron" || (image.trim() !== "" && command.trim() !== "" && schedule.trim().split(/\s+/).length === 5)) &&
    (kind !== "compose" || yaml.trim() !== "");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const base = { projectId, name, nodeId };
    if (kind === "database") {
      createDatabase.mutate({
        ...base,
        engine,
        version: version || undefined,
        variant: engine === "postgres" && withPgvector ? pgvector : undefined,
      });
    } else if (kind === "compose") {
      createStack.mutate({ ...base, source: { type: "inline", yaml }, deployNow });
    } else if (kind === "box") {
      createBox.mutate({ ...base, repository: repository.trim() || undefined });
    } else if (kind === "cron") {
      createService.mutate({
        ...base,
        kind: "cron",
        source: { type: "image", image: image.trim(), registryId: null },
        cron: {
          schedule: schedule.trim(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          command: ["sh", "-c", command.trim()],
          timeoutSeconds: 3600,
          concurrency: "forbid",
        },
      });
    } else {
      const containerPort = Number(port);
      createService.mutate({
        ...base,
        kind: "app",
        source:
          appSource === "image"
            ? { type: "image", image: image.trim(), registryId: null }
            : appSource === "git"
              ? { type: "git", url: gitUrl.trim(), branch: branch.trim() || "main", credentialId: null, deployOnPush: false }
              : undefined,
        ports: Number.isInteger(containerPort) && containerPort > 0 ? [{ containerPort, protocol: "tcp" }] : undefined,
        deployNow: appSource !== "none" && deployNow,
      });
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {meta && <KindBadge tag={meta.tag} tone={meta.tone} />}
        <div className="flex min-w-0 flex-col gap-0.5">
          <DialogTitle>{t(`newService.titles.${kind}`)}</DialogTitle>
          <DialogDescription>{meta && t(meta.description)}</DialogDescription>
        </div>
      </div>

      {!fixedProjectId && (
        <Field id="ns-project" label="newService.project">
          <ProjectPicker id="ns-project" value={projectId} onChange={setProjectId} />
        </Field>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="ns-name" label="newService.name" hint={name !== "" && !nameValid ? "newService.nameInvalid" : undefined}>
          <Input
            id="ns-name"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            maxLength={40}
            placeholder={t(`newService.namePlaceholder.${kind}`)}
            aria-invalid={name !== "" && !nameValid}
            required
            autoFocus
            className="font-mono"
          />
        </Field>
        <Field id="ns-node" label="newService.node">
          <NodePicker id="ns-node" value={nodeId} onChange={setNodeId} />
        </Field>
      </div>

      {kind === "app" && (
        <>
          <Segmented aria-label={t("newService.source")} value={appSource} onValueChange={(v) => setAppSource(v as AppSource)}>
            <SegmentedItem value="image">{t("newService.sourceImage")}</SegmentedItem>
            <SegmentedItem value="git">{t("newService.sourceGit")}</SegmentedItem>
            <SegmentedItem value="none">{t("newService.sourceLater")}</SegmentedItem>
          </Segmented>
          {appSource === "image" && (
            <Field id="ns-image" label="newService.image">
              <Input
                id="ns-image"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="nginx:1.27"
                className="font-mono"
              />
            </Field>
          )}
          {appSource === "git" && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_160px]">
              <Field id="ns-git" label="newService.gitUrl">
                <Input
                  id="ns-git"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/acme/app.git"
                  className="font-mono"
                />
              </Field>
              <Field id="ns-branch" label="newService.branch">
                <Input id="ns-branch" value={branch} onChange={(e) => setBranch(e.target.value)} className="font-mono" />
              </Field>
            </div>
          )}
          {appSource === "none" && <p className="m-0 text-[13px] text-muted-foreground">{t("newService.sourceLaterHint")}</p>}
          {appSource !== "none" && (
            <Field id="ns-port" label="newService.port" hint="newService.portHint">
              <Input
                id="ns-port"
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                placeholder="3000"
              />
            </Field>
          )}
        </>
      )}

      {kind === "cron" && (
        <>
          <Field id="ns-image" label="newService.image">
            <Input id="ns-image" value={image} onChange={(e) => setImage(e.target.value)} placeholder="alpine:3.22" className="font-mono" />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_1fr]">
            <Field id="ns-schedule" label="newService.schedule" hint="newService.scheduleHint">
              <Input id="ns-schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)} className="font-mono" />
            </Field>
            <Field id="ns-command" label="newService.command">
              <Input
                id="ns-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="./cleanup.sh"
                className="font-mono"
              />
            </Field>
          </div>
        </>
      )}

      {kind === "database" && (
        <>
          <RadioGroup
            value={engine}
            onValueChange={(v) => {
              setEngine(v as Engine);
              setVersion("");
            }}
            aria-label={t("newService.engine")}
            className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          >
            {engines.map((item) => (
              <RadioCard
                key={item.engine}
                value={item.engine}
                title={t(item.label)}
                description={item.note && <span className="text-chip-amber-fg">{t(item.note)}</span>}
                icon={<KindBadge tag={item.tag} tone="sky" />}
              />
            ))}
          </RadioGroup>
          <EngineVersion
            engine={engine}
            version={version}
            onVersion={setVersion}
            withPgvector={withPgvector}
            onPgvector={setWithPgvector}
          />
          {engines.map(
            (item) =>
              item.engine === engine &&
              item.notice && (
                <p
                  key={item.engine}
                  role="note"
                  className="m-0 rounded-control bg-chip-amber-bg px-3 py-2.5 text-[12.5px] leading-normal text-chip-amber-fg"
                >
                  {t(item.notice)}
                </p>
              ),
          )}
        </>
      )}

      {kind === "compose" && (
        <>
          <Field id="ns-yaml" label="newService.composeFile">
            <Textarea
              id="ns-yaml"
              mono
              rows={9}
              value={yaml}
              onChange={(e) => {
                setYaml(e.target.value);
                preview.reset();
              }}
              placeholder={"services:\n  web:\n    image: nginx:1.27"}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!ready || preview.isPending}
              onClick={() => preview.mutate({ projectId, name, nodeId, source: { type: "inline", yaml } })}
            >
              {t("newService.preview")}
            </Button>
            {preview.error && (
              <span className="text-[12.5px] text-destructive">{errorMessage(preview.error, t("common.unknownError"))}</span>
            )}
          </div>
          {preview.data && <ComposePreviewList preview={preview.data} />}
        </>
      )}

      {kind === "box" && (
        <Field id="ns-repo" label="newService.repository" hint="newService.repositoryHint">
          <Input
            id="ns-repo"
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            placeholder="https://github.com/acme/app.git"
            className="font-mono"
          />
        </Field>
      )}

      {(kind === "compose" || (kind === "app" && appSource !== "none")) && (
        <label htmlFor="ns-deploy" className="flex items-center gap-2.5 text-[13px] text-ink-strong">
          <Checkbox id="ns-deploy" checked={deployNow} onCheckedChange={(v) => setDeployNow(v === true)} />
          {t("newService.deployNow")}
        </label>
      )}

      {error !== null && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {error instanceof OpError && error.code === "NOT_IMPLEMENTED"
            ? t("newService.notBuilt", { message: error.message })
            : errorMessage(error, t("common.unknownError"))}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!ready || pending}>
          {pending ? t("newService.creating") : t("common.create")}
        </Button>
      </div>
    </form>
  );
}

/**
 * The engine's versions from the panel's catalog (databases.engines), newest
 * first, and the pgvector checkbox for Postgres. A version the variant does
 * not have falls back to the newest.
 */
function EngineVersion({
  engine,
  version,
  onVersion,
  withPgvector,
  onPgvector,
}: {
  engine: Engine;
  version: string;
  onVersion: (version: string) => void;
  withPgvector: boolean;
  onPgvector: (on: boolean) => void;
}) {
  const catalog = useOp(databases.engines, {}, { staleTime: Number.POSITIVE_INFINITY });
  if (catalog.isError) return <QueryError error={catalog.error} onRetry={() => void catalog.refetch()} />;
  const info = catalog.data?.engines.find((e) => e.engine === engine);
  if (!info) {
    return (
      <LoadingRegion label={t("newService.versionsLoading")}>
        <FieldSkeleton labelWidth="w-14" hint />
      </LoadingRegion>
    );
  }
  const variant = info.variants.find((v) => v.id === pgvector);
  const versions = (withPgvector && variant ? variant : info).versions;
  const newest = versions[0]?.version ?? "";
  const current = versions.some((v) => v.version === version) ? version : newest;
  return (
    <>
      <Field id="ns-version" label="newService.version" hint="newService.versionHint">
        <Select value={current} onValueChange={(v) => onVersion(v === newest ? "" : v)}>
          <SelectTrigger id="ns-version" className="font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {versions.map((v) => (
              <SelectItem key={v.version} value={v.version}>
                <span className="flex min-w-0 items-center gap-2">
                  {v.version === newest ? t("newService.versionLatest", { version: v.version }) : v.version}
                  <span title={v.image} className="max-w-[260px] truncate font-mono text-xs text-muted-foreground">
                    {shortImage(v.image)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {variant && (
        <div className="flex flex-col gap-1">
          <label htmlFor="ns-pgvector" className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-strong">
            <Checkbox id="ns-pgvector" checked={withPgvector} onCheckedChange={(v) => onPgvector(v === true)} />
            {t("newService.pgvector")}
          </label>
          <span className="pl-[26px] text-xs text-muted-foreground">{t("newService.pgvectorHint")}</span>
        </div>
      )}
    </>
  );
}

function ComposePreviewList({ preview }: { preview: ComposePreview }) {
  return (
    <div className="flex flex-col gap-2 rounded-control bg-accent p-3.5 text-[13px]">
      <b className="font-semibold">{t("newService.thisCreates")}</b>
      {preview.members.map((member) => (
        <span key={member.composeService} className="flex items-center gap-2">
          <KindBadge tag="APP" tone="blue" className="h-[22px]" />
          <span className="truncate">
            {member.name}
            {t("format.separator")}
            <span className="font-mono text-[12px]">{member.image}</span>
          </span>
        </span>
      ))}
      {preview.warnings.map((warning) => (
        <span key={warning} className="text-[12.5px] text-chip-amber-fg">
          {warning}
        </span>
      ))}
    </div>
  );
}

function Field({ id, label, hint, children }: { id: string; label: MessageKey; hint?: MessageKey; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{t(label)}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{t(hint)}</span>}
    </div>
  );
}
