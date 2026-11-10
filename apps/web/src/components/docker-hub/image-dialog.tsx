// Setting up a Docker Hub image as an app: pick a tag (the suggested one is
// pinned to the version latest points at), and the form fills itself from
// the image's config (dockerHub.inspect for the chosen node's CPU): the main
// port from EXPOSE, a volume per VOLUME path, the image's ENV in the .env
// editor with secret-looking names left empty. One click creates and
// deploys it (dockerHub.create), like a template.

import { analyzeEnv } from "@seylo/env-analyzer";
import { dockerHub, nodes, registries } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Chip } from "@seylo/ui/components/chip";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input, Label } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { FieldSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { IconBrandDocker, IconX } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { NodePicker, ProjectPicker } from "../pickers";
import { QueryError } from "../query-error";
import { EnvEditor } from "../service/editor/env-editor";
import { shortDigest } from "../service/format";
import { retryOp } from "../service/op-state";
import { TemplateLogo } from "../templates/template-logo";
import {
  archOf,
  commandLine,
  defaultServiceName,
  type ImageConfig,
  portChoices,
  prefillEnv,
  publicByDefault,
  splitCommand,
  volumePaths,
} from "./prefill";
import { TagPicker } from "./tag-picker";

/** What the dialog sets up: a search result or a popular image with its presets. */
export interface HubTarget {
  repository: string;
  description?: string;
  /** A popular image's logo, shown in the dialog's header. */
  logoUrl?: string;
  port?: number;
  volumes?: string[];
  env?: Record<string, string>;
}

const namePattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const dockerHubServers = new Set(["docker.io", "index.docker.io", "registry.hub.docker.com", "registry-1.docker.io"]);

export function ImageDialog({ target, projectId, onClose }: { target: HubTarget | null; projectId?: string; onClose: () => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="top-[5%] flex max-h-[90dvh] max-w-[880px] flex-col overflow-hidden p-0">
        {target && <ImageForm key={target.repository} target={target} fixedProjectId={projectId} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

interface FormState {
  /** The config the state was filled from ("<digest>"), so a new tag refills it. */
  from: string;
  port: string;
  public: boolean;
  volumes: Record<string, boolean>;
  env: string;
  command: string;
}

function initialState(config: ImageConfig, target: HubTarget): FormState {
  const { main } = portChoices(config, target.port);
  return {
    from: config.digest,
    port: main === null ? "" : String(main),
    public: publicByDefault(main),
    volumes: Object.fromEntries(volumePaths(config, target.volumes).map((path) => [path, true])),
    env: prefillEnv(config.env, t("dockerHub.envSecretsNote"), target.env),
    command: "",
  };
}

function ImageForm({ target, fixedProjectId, onClose }: { target: HubTarget; fixedProjectId?: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState(fixedProjectId ?? "");
  const [nodeId, setNodeId] = useState("");
  const [name, setName] = useState(() => defaultServiceName(target.repository));
  const [tag, setTag] = useState<string | null>(null);
  const [state, setState] = useState<FormState | null>(null);
  // undefined: automatic (the Docker Hub login for a private image, else none).
  const [registryChoice, setRegistryChoice] = useState<string | null | undefined>(undefined);
  const [deployNow, setDeployNow] = useState(true);

  const tags = useOp(dockerHub.tags, { repository: target.repository }, { retry: retryOp, staleTime: 5 * 60_000 });
  // The suggested tag (pinned to latest's version) until the person picks another.
  const chosenTag = tag ?? tags.data?.suggested ?? null;
  // The same list the node field reads, so members get the architecture too.
  const nodeList = useOp(nodes.choices, {}, { retry: retryOp });
  const nodeArch = nodeList.data?.nodes.find((n) => n.id === nodeId)?.arch === "arm64" ? "arm64" : "amd64";
  const inspect = useOp(
    dockerHub.inspect,
    { repository: target.repository, tag: chosenTag ?? "latest", arch: nodeArch },
    { enabled: chosenTag !== null, retry: retryOp, staleTime: 10 * 60_000 },
  );
  const config = inspect.data;
  const logins = (useOp(registries.list, {}, { retry: retryOp }).data?.registries ?? []).filter((r) =>
    dockerHubServers.has(r.server.toLowerCase()),
  );

  // A private image needs the login on the node too: the one the panel read it with.
  const registryId = registryChoice === undefined ? (config?.registryId ?? null) : registryChoice;

  // Refill the form when a different image config arrives (another tag).
  useEffect(() => {
    if (config && state?.from !== config.digest) setState(initialState(config, target));
  }, [config, state?.from, target]);

  const create = useOpMutation(dockerHub.create, {
    onSuccess: (service) => {
      toast.success(t("dockerHub.created", { name: service.name }));
      onClose();
      void navigate({ to: "/p/$projectId/s/$serviceId", params: { projectId: service.projectId, serviceId: service.id } });
    },
  });

  const ports = config ? portChoices(config, target.port).ports : [];
  const nameValid = namePattern.test(name);
  const ready = nameValid && projectId !== "" && nodeId !== "" && chosenTag !== null && config !== undefined && state !== null;
  const wrongArch = config && archOf(config.platform) !== nodeArch;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !state || !chosenTag) return;
    const port = Number(state.port);
    const command = splitCommand(state.command);
    create.mutate({
      projectId,
      name,
      nodeId,
      repository: target.repository,
      tag: chosenTag,
      registryId,
      port: Number.isInteger(port) && port > 0 ? port : null,
      public: state.public,
      volumes: Object.entries(state.volumes)
        .filter(([, on]) => on)
        .map(([mountPath]) => ({ mountPath })),
      env: state.env,
      ...(command.length > 0 ? { command } : {}),
      deployNow,
    });
  };

  return (
    // Only the middle scrolls: the title and the Create button stay in view on a short screen.
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-divider px-[22px] py-[18px]">
        <TemplateLogo slug={target.repository} name={defaultServiceName(target.repository)} logoUrl={target.logoUrl ?? null} size={38} />
        <span className="flex min-w-0 flex-col gap-px">
          <DialogTitle className="text-base">{t("dockerHub.dialogTitle", { name: target.repository })}</DialogTitle>
          <DialogDescription className="truncate text-[12.5px]">{target.description || t("dockerHub.fromDockerHub")}</DialogDescription>
        </span>
        <DialogClose asChild>
          <Button size="icon" className="ml-auto size-8 rounded-control bg-muted shadow-none" aria-label={t("common.close")}>
            <IconX size={15} stroke={2} />
          </Button>
        </DialogClose>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-1 gap-[22px] px-[22px] py-5 md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-w-0 flex-col gap-[13px]">
            {!fixedProjectId && (
              <Labeled id="hub-project" label={t("newService.project")}>
                <ProjectPicker id="hub-project" value={projectId} onChange={setProjectId} />
              </Labeled>
            )}
            <div className="grid grid-cols-1 gap-[13px] sm:grid-cols-2">
              <Labeled
                id="hub-name"
                label={t("templates.serviceName")}
                hint={name !== "" && !nameValid ? t("newService.nameInvalid") : undefined}
              >
                <Input
                  id="hub-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase())}
                  maxLength={40}
                  required
                  aria-invalid={name !== "" && !nameValid}
                  className="font-mono"
                />
              </Labeled>
              <Labeled id="hub-node" label={t("newService.node")}>
                <NodePicker id="hub-node" value={nodeId} onChange={setNodeId} />
              </Labeled>
            </div>
            <Labeled id="hub-tag" label={t("dockerHub.tag")}>
              {tags.isError ? (
                <QueryError error={tags.error} onRetry={() => void tags.refetch()} />
              ) : (
                <TagPicker
                  id="hub-tag"
                  repository={target.repository}
                  value={chosenTag}
                  suggested={tags.data?.suggested ?? null}
                  firstPage={tags.data?.tags}
                  onChange={setTag}
                />
              )}
            </Labeled>

            {chosenTag !== null && inspect.isError && <QueryError error={inspect.error} onRetry={() => void inspect.refetch()} />}
            {(tags.isPending || (chosenTag !== null && inspect.isPending) || (config && !state)) && !inspect.isError && (
              <LoadingRegion label={t("dockerHub.reading")} className="flex flex-col gap-[13px]">
                <div className="grid grid-cols-1 gap-[13px] sm:grid-cols-2">
                  <FieldSkeleton labelWidth="w-10" hint />
                </div>
                <div className="flex items-start gap-2.5">
                  <Skeleton className="mt-0.5 h-5 w-9 shrink-0 rounded-full" />
                  <span className="flex flex-col gap-0.5">
                    <SkeletonText className="w-40 text-[13px]" />
                    <SkeletonText className="w-64 text-xs" />
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  <SkeletonText className="mb-1.5 w-16 text-[13px]" />
                  <div className="flex items-center gap-2.5">
                    <Skeleton className="size-4 shrink-0 rounded-[4px]" />
                    <SkeletonText className="w-28 text-[12.5px]" />
                  </div>
                </div>
                <FieldSkeleton labelWidth="w-20" hint />
              </LoadingRegion>
            )}
            {config && state && (
              <>
                <div className="grid grid-cols-1 gap-[13px] sm:grid-cols-2">
                  <Labeled id="hub-port" label={t("dockerHub.port")} hint={ports.length > 0 ? t("dockerHub.portHint") : undefined}>
                    {ports.length > 0 ? (
                      <Select
                        value={state.port === "" ? "none" : state.port}
                        onValueChange={(value) => {
                          const port = value === "none" ? "" : value;
                          setState({ ...state, port, public: port === "" ? false : publicByDefault(Number(port)) });
                        }}
                      >
                        <SelectTrigger id="hub-port">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ports.map((port) => (
                            <SelectItem key={port} value={String(port)}>
                              <span className="font-mono">{port}</span>
                            </SelectItem>
                          ))}
                          <SelectItem value="none">{t("dockerHub.portNone")}</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id="hub-port"
                        inputMode="numeric"
                        value={state.port}
                        onChange={(e) => setState({ ...state, port: e.target.value.replace(/\D/g, "").slice(0, 5) })}
                        placeholder={t("dockerHub.portCustom")}
                      />
                    )}
                  </Labeled>
                  {logins.length > 0 && (
                    <Labeled id="hub-login" label={t("dockerHub.pullWith")}>
                      <Select
                        value={registryId ?? "anonymous"}
                        onValueChange={(value) => setRegistryChoice(value === "anonymous" ? null : value)}
                      >
                        <SelectTrigger id="hub-login">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="anonymous">{t("dockerHub.pullAnonymous")}</SelectItem>
                          {logins.map((login) => (
                            <SelectItem key={login.id} value={login.id}>
                              {login.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Labeled>
                  )}
                </div>
                {state.port !== "" && (
                  <label htmlFor="hub-public" className="flex cursor-pointer items-start gap-2.5 text-[13px]">
                    <Switch
                      id="hub-public"
                      checked={state.public}
                      onCheckedChange={(on) => setState({ ...state, public: on })}
                      className="mt-0.5"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground">{t("dockerHub.public")}</span>
                      <span className="text-xs text-muted-foreground">{t("dockerHub.publicHint")}</span>
                    </span>
                  </label>
                )}
                <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
                  <legend className="mb-1.5 p-0 text-[13px] font-medium text-foreground">{t("dockerHub.volumes")}</legend>
                  {Object.keys(state.volumes).length === 0 ? (
                    <span className="text-xs text-muted-foreground">{t("dockerHub.volumesNone")}</span>
                  ) : (
                    <>
                      {Object.keys(state.volumes).map((path) => (
                        <label key={path} htmlFor={`hub-vol-${path}`} className="flex cursor-pointer items-center gap-2.5 text-[13px]">
                          <Checkbox
                            id={`hub-vol-${path}`}
                            checked={state.volumes[path] === true}
                            onCheckedChange={(on) => setState({ ...state, volumes: { ...state.volumes, [path]: on === true } })}
                          />
                          <span className="font-mono text-[12.5px] text-foreground">{path}</span>
                        </label>
                      ))}
                      <span className="text-xs text-muted-foreground">{t("dockerHub.volumesHint")}</span>
                    </>
                  )}
                </fieldset>
                <Labeled
                  id="hub-command"
                  label={t("dockerHub.command")}
                  hint={t("dockerHub.commandHint", { command: commandLine(config) || "-" })}
                >
                  <Input
                    id="hub-command"
                    value={state.command}
                    onChange={(e) => setState({ ...state, command: e.target.value })}
                    placeholder={config.cmd.join(" ")}
                    className="font-mono"
                  />
                </Labeled>
              </>
            )}
          </div>

          <ImageFacts config={config} wrongArch={wrongArch ? nodeArch : null} />
        </div>

        {config && state && (
          <div className="flex flex-col gap-1.5 px-[22px] pb-5">
            <span className="text-[13px] font-medium text-foreground">{t("dockerHub.env")}</span>
            <EnvSection key={state.from} name={name} text={state.env} onChange={(env) => setState({ ...state, env })} />
            <span className="text-xs text-muted-foreground">{t("dockerHub.envHint")}</span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2.5 rounded-b-card border-t border-divider bg-raised px-[22px] py-3.5">
        <label htmlFor="hub-deploy" className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-strong">
          <Checkbox id="hub-deploy" checked={deployNow} onCheckedChange={(on) => setDeployNow(on === true)} />
          {t("newService.deployNow")}
        </label>
        {create.error && (
          <span role="alert" className="text-[12.5px] text-destructive">
            {errorMessage(create.error, t("common.unknownError"))}
          </span>
        )}
        <Button className="ml-auto" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={!ready || create.isPending}>
          {create.isPending ? t("dockerHub.creating") : deployNow ? t("dockerHub.create") : t("dockerHub.createOnly")}
        </Button>
      </div>
    </form>
  );
}

function EnvSection({ name, text, onChange }: { name: string; text: string; onChange: (text: string) => void }) {
  const context = useMemo(() => ({ self: { serviceId: null, name, nodes: [] }, targets: [] }), [name]);
  const analysis = useMemo(() => analyzeEnv(text, context), [text, context]);
  return (
    // A border, not the inset shadow-control ring: the editor paints its own background over an inset ring, so in dark it had no edge.
    <div className="overflow-hidden rounded-control border border-input">
      <EnvEditor
        text={text}
        onChange={onChange}
        analysis={analysis}
        context={context}
        selfName={name}
        reveal
        onSave={() => {}}
        height={200}
      />
    </div>
  );
}

/** The right column: what the image itself says, read only. */
function ImageFacts({ config, wrongArch }: { config: ImageConfig | undefined; wrongArch: string | null }) {
  if (!config) {
    return (
      <LoadingRegion
        label={t("dockerHub.reading")}
        className="flex min-w-0 flex-col gap-3 self-start rounded-card px-4 py-3.5 text-[12.5px] bg-highlight"
      >
        <span className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
          <IconBrandDocker size={16} stroke={1.8} aria-hidden="true" />
          {t("dockerHub.image")}
        </span>
        {[
          [t("dockerHub.digest"), "w-28"],
          [t("dockerHub.platforms"), "w-24"],
          [t("dockerHub.runs"), "w-3/4"],
          [t("dockerHub.user"), "w-12"],
          [t("dockerHub.healthcheck"), "w-2/3"],
        ].map(([label, width]) => (
          <div key={label} className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11.5px] text-muted-foreground">{label}</span>
            <SkeletonText className={width} />
          </div>
        ))}
      </LoadingRegion>
    );
  }
  const health = config.healthcheck && config.healthcheck.test[0] !== "NONE" ? config.healthcheck.test.slice(1).join(" ") : null;
  return (
    <div className="flex min-w-0 flex-col gap-3 self-start rounded-card px-4 py-3.5 text-[12.5px] bg-highlight">
      <span className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
        <IconBrandDocker size={16} stroke={1.8} aria-hidden="true" />
        {t("dockerHub.image")}
      </span>
      {config.private && (
        <Alert tone="info" icon={null} className="px-3 py-2 text-xs">
          {t("dockerHub.private")}
        </Alert>
      )}
      {wrongArch && (
        <Alert tone="warning" icon={null} className="px-3 py-2 text-xs">
          {t("dockerHub.archMismatch", { arch: `linux/${wrongArch}`, platform: config.platform })}
        </Alert>
      )}
      <Fact label={t("dockerHub.digest")}>
        <span className="font-mono" title={config.digest}>
          {shortDigest(config.digest)}
        </span>
      </Fact>
      <Fact label={t("dockerHub.platforms")}>
        <span className="flex flex-wrap gap-1">
          {config.platforms.map((platform) => (
            <Chip key={platform} tone={platform === config.platform ? "blue" : "gray"} mono className="text-[11px]">
              {platform.replace(/^linux\//, "")}
            </Chip>
          ))}
        </span>
      </Fact>
      <Fact label={t("dockerHub.runs")}>
        <span className="font-mono [overflow-wrap:anywhere]">{commandLine(config) || "-"}</span>
      </Fact>
      <Fact label={t("dockerHub.user")}>
        <span className="font-mono">{config.user || t("dockerHub.userRoot")}</span>
      </Fact>
      <Fact label={t("dockerHub.healthcheck")}>
        <span className="font-mono [overflow-wrap:anywhere]">{health ?? t("dockerHub.healthcheckNone")}</span>
      </Fact>
      {config.labels.length > 0 && (
        <details className="group">
          <summary className="text-muted-foreground hover:text-foreground">
            {t("dockerHub.labels")} ({config.labels.length})
          </summary>
          <dl className="m-0 mt-1.5 flex flex-col gap-1">
            {config.labels.map((label) => (
              <div key={label.name} className="min-w-0">
                <dt className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{label.name}</dt>
                <dd className="m-0 font-mono text-[11.5px] text-foreground [overflow-wrap:anywhere]">{label.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

function Labeled({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}
