// The create form behind each "New service" choice. Every kind asks for a
// project (unless the screen already has one), a name and a node; the rest
// depends on the kind:
//   app       a Docker image (its exposed port fills Port), a GitHub
//             repository (owner/repo, a github.com address or one picked
//             from the GitHub App and the connected GitHub account,
//             repo-field.tsx; setup steps while nothing is connected), a
//             plain git URL, or nothing (set the source later); Port is 80
//             unless the image says otherwise or it is edited
//   cron      an image, a schedule and a command
//   database  the engine, its version (and pgvector for Postgres)
//   compose   a pasted compose file, previewed before it is created
//   box       an optional repository to clone
// After creating, the service page opens. A GitHub repository read through
// a connection is connected right after the service is made
// (services.create takes no such source: github.connectRepo checks the App
// or the account can read it, and creates the repository webhook for the
// account), then deployed when "Deploy right away" is ticked; if
// connecting fails, the service's Source tab opens instead. An SSH URL is
// created without the first deploy: it has no deploy key yet.

import { boxes, compose, databases, deployments, dockerHub, github, OpError, type OpInput, type OpOutput, services } from "@seylo/ops";
import { useOp, useOpClient, useOpMutation } from "@seylo/ops/react";
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
import { cn } from "@seylo/ui/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { type MessageKey, t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import type { ComposePreview } from "../../lib/types";
import { portChoices } from "../docker-hub/prefill";
import { useDebounced } from "../docker-hub/use-debounced";
import { InternalHostNote, useCanManageGit } from "../git/internal-hosts";
import { NodePicker, ProjectPicker } from "../pickers";
import { QueryError } from "../query-error";
import { GithubSetup, GithubTabSkeleton } from "./github-setup";
import { dockerHubRef } from "./image-port";
import { type CatalogKind, KindBadge, type NewServiceKind, newServiceKinds } from "./kinds";
import { BranchField, type BranchSuggestions, RepoField, RepoNote, useBranchSuggestions, useRepoSource } from "./repo-field";
import { branchFromRef, parseRepoInput } from "./repo-input";
import { type FoundRepo, type RepoDecision, repoKeyOf, sourceFor, textFor } from "./repo-source";
import { shortImage } from "./short-image";

type FormKind = Exclude<NewServiceKind, CatalogKind>;
type AppSource = "image" | "github" | "git" | "none";
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
const pgvectorSql = "CREATE EXTENSION vector;";

/** What the Port field starts with: most web images and servers listen on 80, and built apps get it as PORT. */
export const defaultPort = "80";

const namePattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const branchPattern = new RegExp(services.GitBranch.pattern as string);

type Source = (typeof services.Source)["static"];
type ConnectedSource = Extract<Source, { type: "github" }>;

/** services.create, then connecting the repository through its connection, then (optionally) the first deploy. */
interface ConnectPlan {
  create: OpInput<typeof services.create>;
  source: ConnectedSource;
  deployNow: boolean;
}

interface ConnectResult {
  created: OpOutput<typeof services.create>;
  /** The step that failed after the service was made, if one did. */
  failed: { step: "connect" | "deploy"; error: unknown } | null;
}

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

/**
 * The branch for a repository: the one typed or picked for it (edits are
 * kept per repository, repoKeyOf), else the one its page address names,
 * else its default branch, else main. An empty field is the suggestion.
 */
function useBranch(key: string, ref: string[] | null, suggestions: BranchSuggestions) {
  const [edit, setEdit] = useState<{ key: string; value: string } | null>(null);
  const edited = edit !== null && edit.key === key;
  // A page address (".../tree/feat/queue/src") names the branch, maybe with a folder after it: the
  // longest start that is one of the repository's branches. Until they are read it waits.
  const refPending = !edited && ref !== null && suggestions.loading;
  const listed = suggestions.available && !suggestions.error ? (suggestions.branches ?? null) : null;
  const suggested = (refPending ? null : branchFromRef(ref, listed)) ?? suggestions.defaultBranch ?? "main";
  const value = edited ? edit.value : suggested;
  const toUse = value.trim() || suggested;
  return {
    value,
    suggested,
    toUse,
    valid: branchPattern.test(toUse),
    pending: refPending,
    set: (next: string) => setEdit({ key, value: next }),
  };
}

function NewServiceForm({ kind, fixedProjectId, onClose }: { kind: FormKind; fixedProjectId?: string; onClose: () => void }) {
  const navigate = useNavigate();
  const meta = newServiceKinds.find((item) => item.kind === kind);
  const [projectId, setProjectId] = useState(fixedProjectId ?? "");
  const [nodeId, setNodeId] = useState("");
  const [name, setName] = useState("");
  const [appSource, setAppSource] = useState<AppSource>("image");
  const [image, setImage] = useState("");
  const [repoText, setRepoText] = useState("");
  // A repository picked from Browse, while the field still shows what picking it wrote, in the project it was picked for.
  const [picked, setPicked] = useState<{ text: string; projectId: string; found: FoundRepo } | null>(null);
  const [gitUrl, setGitUrl] = useState("");
  // null: the default (80, or the port the Docker Hub image exposes); a string once someone typed in the field.
  const [portEdit, setPortEdit] = useState<string | null>(null);
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
  const client = useOpClient();
  const createAndConnect = useMutation<ConnectResult, unknown, ConnectPlan>({
    mutationFn: async ({ create, source, deployNow: deploy }) => {
      const created = await client.call(services.create, create);
      try {
        await client.call(github.connectRepo, {
          serviceId: created.id,
          ...(source.installationId ? { installationId: source.installationId } : { accountId: source.accountId ?? "" }),
          repo: source.repo,
          branch: source.branch,
          deployOnPush: source.deployOnPush,
        });
      } catch (cause) {
        return { created, failed: { step: "connect", error: cause } };
      }
      if (deploy) {
        try {
          await client.call(deployments.deploy, { serviceId: created.id });
        } catch (cause) {
          return { created, failed: { step: "deploy", error: cause } };
        }
      }
      return { created, failed: null };
    },
    onSuccess: ({ created, failed }, plan) => {
      if (!failed) return opened(created.id, created.projectId);
      const description = errorMessage(failed.error, t("common.unknownError"));
      onClose();
      if (failed.step === "connect") {
        toast.error(t("newService.connectFailed", { name: created.name, repo: plan.source.repo }), { description });
        void navigate({ to: "/p/$projectId/s/$serviceId/source", params: { projectId: created.projectId, serviceId: created.id } });
      } else {
        toast.error(t("newService.deployFailed", { name: created.name }), { description });
        void navigate({ to: "/p/$projectId/s/$serviceId", params: { projectId: created.projectId, serviceId: created.id } });
      }
    },
    onError,
  });
  const pending =
    createService.isPending || createDatabase.isPending || createStack.isPending || createBox.isPending || createAndConnect.isPending;

  // The GitHub tab: the picker over the App installations and the connected account.
  const githubTab = kind === "app" && appSource === "github";
  const canManage = useCanManageGit();
  const repoSource = useRepoSource({
    projectId,
    text: repoText,
    // Picked in another project: the text is looked up again in this one (connectRepo checks the project's sharing).
    picked: picked && picked.text === repoText && picked.projectId === projectId ? picked.found : null,
    // Loaded with the dialog, so the tab knows at once whether anything is connected.
    enabled: kind === "app",
  });
  const githubBranches = useBranchSuggestions(projectId, repoSource.decision, githubTab);
  const githubRef = repoSource.parse.ok ? repoSource.parse.repo.ref : null;
  const githubBranch = useBranch(repoKeyOf(repoSource.parse), githubRef, githubBranches);
  // Nothing on GitHub to pick from: the tab shows how to connect it instead of the field.
  const githubEmpty = !repoSource.listsPending && repoSource.listError == null && repoSource.connections.length === 0;

  // The Git repository tab: a URL, nothing looked up but its branches.
  const gitTab = kind === "app" && appSource === "git";
  const gitParse = parseRepoInput(gitUrl, [], { shorthand: false });
  const gitDecision: RepoDecision = gitParse.ok
    ? { type: "git", repo: gitParse.repo, missedIn: null }
    : { type: "none", problem: gitParse.problem };
  const gitBranches = useBranchSuggestions(projectId, gitDecision, gitTab);
  const gitBranch = useBranch(repoKeyOf(gitParse), gitParse.ok ? gitParse.repo.ref : null, gitBranches);

  const repoSourceToCreate = githubTab
    ? githubBranch.valid && !githubBranch.pending && !githubEmpty
      ? sourceFor(repoSource.decision, githubBranch.toUse)
      : null
    : gitTab && gitBranch.valid && !gitBranch.pending
      ? sourceFor(gitDecision, gitBranch.toUse)
      : null;
  const repoDecision = githubTab ? repoSource.decision : gitDecision;
  // An SSH URL has no deploy key yet: its first deploy can only fail.
  const deployBlocked = (githubTab || gitTab) && repoDecision.type === "git" && repoDecision.repo.ssh;

  // The image's exposed port, from Docker Hub, once the name rests.
  const hubRef = dockerHubRef(useDebounced(image, 600));
  const hub = useOp(dockerHub.inspect, hubRef ?? { repository: "nginx", tag: "latest" }, {
    enabled: kind === "app" && appSource === "image" && hubRef !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const imagePort = appSource === "image" && hubRef && hub.data ? portChoices(hub.data).main : null;
  const port = portEdit ?? (imagePort ? String(imagePort) : defaultPort);
  const portHint: { key: MessageKey; params?: Record<string, string> } =
    portEdit === null && imagePort && hubRef
      ? { key: "newService.portFromImage", params: { image: hubRef.repository } }
      : appSource === "github" || appSource === "git"
        ? { key: "newService.portBuilt" }
        : { key: "newService.portHint" };

  const nameValid = namePattern.test(name);
  const ready =
    nameValid &&
    projectId !== "" &&
    nodeId !== "" &&
    (kind !== "app" || appSource === "none" || (appSource === "image" ? image.trim() !== "" : repoSourceToCreate !== null)) &&
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
      const ports =
        Number.isInteger(containerPort) && containerPort > 0 && containerPort <= 65535
          ? [{ containerPort, protocol: "tcp" as const }]
          : undefined;
      const source: Source | undefined =
        appSource === "image"
          ? { type: "image", image: image.trim(), registryId: null }
          : appSource === "github" || appSource === "git"
            ? (repoSourceToCreate ?? undefined)
            : undefined;
      const deploy = deployNow && !deployBlocked;
      if (source?.type === "github") {
        createAndConnect.mutate({ create: { ...base, kind: "app", ports, deployNow: false }, source, deployNow: deploy });
        return;
      }
      createService.mutate({ ...base, kind: "app", source, ports, deployNow: appSource !== "none" && deploy });
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {meta && <KindBadge tag={meta.tag} tone={meta.tone} />}
        <div className="flex min-w-0 flex-col gap-0.5">
          <DialogTitle>{t(`newService.titles.${kind}`)}</DialogTitle>
          <DialogDescription>{t(`newService.dialogHints.${kind}`)}</DialogDescription>
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
          <div className="flex flex-col gap-1.5">
            <span id="ns-source-label" className="text-[13px] font-medium text-ink-strong">
              {t("newService.source")}
            </span>
            <Segmented
              aria-label={t("newService.source")}
              value={appSource}
              onValueChange={(v) => setAppSource(v as AppSource)}
              // Four choices: the track hugs them, and on a phone it scrolls sideways (Segmented does
              // that itself) instead of widening the dialog.
              className="self-start"
            >
              <SegmentedItem value="image">{t("newService.sourceImage")}</SegmentedItem>
              <SegmentedItem value="github">{t("newService.sourceGithub")}</SegmentedItem>
              <SegmentedItem value="git">{t("newService.sourceGit")}</SegmentedItem>
              <SegmentedItem value="none">{t("newService.sourceLater")}</SegmentedItem>
            </Segmented>
          </div>
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
          {appSource === "github" &&
            (repoSource.listsPending ? (
              <GithubTabSkeleton />
            ) : githubEmpty ? (
              <GithubSetup canManage={canManage && !repoSource.hidden} onOpen={onClose} />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_160px]">
                <Field
                  id="ns-github"
                  label="newService.gitRepo"
                  note={<RepoNote id="ns-github-note" text={repoText} decision={repoSource.decision} onRetry={repoSource.retry} />}
                >
                  <RepoField
                    id="ns-github"
                    noteId="ns-github-note"
                    value={repoText}
                    onChange={setRepoText}
                    onPick={(found) => {
                      const text = textFor(found);
                      setPicked({ text, projectId, found });
                      setRepoText(text);
                    }}
                    projectId={projectId}
                    source={repoSource}
                  />
                </Field>
                <Field id="ns-branch" label="newService.branch" hint={githubBranch.valid ? undefined : "newService.branchInvalid"}>
                  <BranchField
                    id="ns-branch"
                    value={githubBranch.value}
                    placeholder={githubBranch.suggested}
                    invalid={!githubBranch.valid}
                    describedBy={githubBranch.valid ? undefined : "ns-branch-hint"}
                    onChange={githubBranch.set}
                    suggestions={githubBranches}
                  />
                </Field>
              </div>
            ))}
          {appSource === "git" && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_160px]">
              <Field
                id="ns-git"
                label="newService.gitUrl"
                note={<RepoNote id="ns-git-note" text={gitUrl} decision={gitDecision} tab="git" />}
              >
                <Input
                  id="ns-git"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder={t("newService.git.placeholder")}
                  aria-describedby="ns-git-note"
                  aria-invalid={
                    gitDecision.type === "none" && (gitDecision.problem === "credentials" || gitDecision.problem === "insecure")
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </Field>
              <Field id="ns-git-branch" label="newService.branch" hint={gitBranch.valid ? undefined : "newService.branchInvalid"}>
                <BranchField
                  id="ns-git-branch"
                  value={gitBranch.value}
                  placeholder={gitBranch.suggested}
                  invalid={!gitBranch.valid}
                  describedBy={gitBranch.valid ? undefined : "ns-git-branch-hint"}
                  onChange={gitBranch.set}
                  suggestions={gitBranches}
                />
              </Field>
            </div>
          )}
          {appSource === "none" && <p className="m-0 text-[13px] text-muted-foreground">{t("newService.sourceLaterHint")}</p>}
          {appSource !== "none" && !(appSource === "github" && githubEmpty) && (
            <Field id="ns-port" label="newService.port" hintText={t(portHint.key, portHint.params)}>
              <Input
                id="ns-port"
                inputMode="numeric"
                value={port}
                onChange={(e) => setPortEdit(e.target.value.replace(/\D/g, "").slice(0, 5))}
                aria-describedby="ns-port-hint"
                className="font-mono sm:max-w-[160px]"
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
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_1fr]">
              <Field id="ns-schedule" label="newService.schedule">
                <Input
                  id="ns-schedule"
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  aria-describedby="ns-schedule-hint"
                  className="font-mono"
                />
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
            {/* Under both fields, so it reads on one line. */}
            <span id="ns-schedule-hint" className="text-xs text-muted-foreground">
              {t("newService.scheduleHint")}
            </span>
          </div>
        </>
      )}

      {kind === "database" && (
        <>
          <div className="flex flex-col gap-1.5">
            <span id="ns-engine-label" className="text-[13px] font-medium text-ink-strong">
              {t("newService.engine")}
            </span>
            <RadioGroup
              value={engine}
              onValueChange={(v) => {
                setEngine(v as Engine);
                setVersion("");
              }}
              aria-labelledby="ns-engine-label"
              className="grid grid-cols-2 gap-2 sm:grid-cols-3"
            >
              {engines.map((item) => (
                <RadioCard
                  key={item.engine}
                  value={item.engine}
                  title={t(item.label)}
                  description={item.note && <span className="text-chip-amber-fg">{t(item.note)}</span>}
                  icon={<KindBadge tag={item.tag} tone="sky" />}
                  // The badge is taller than one line of title: centred against the text, in a tile of any height.
                  className="items-center"
                />
              ))}
            </RadioGroup>
          </div>
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
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="ns-yaml">{t("newService.composeFile")}</Label>
              <Button
                size="sm"
                variant="ghost"
                disabled={!ready || preview.isPending}
                onClick={() => preview.mutate({ projectId, name, nodeId, source: { type: "inline", yaml } })}
              >
                {t("newService.preview")}
              </Button>
            </div>
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
            {preview.error ? (
              <span className="text-[12.5px] text-destructive">{errorMessage(preview.error, t("common.unknownError"))}</span>
            ) : (
              yaml.trim() !== "" && !ready && <span className="text-xs text-muted-foreground">{t("newService.previewNeeds")}</span>
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

      {(kind === "compose" || (kind === "app" && appSource !== "none" && !(appSource === "github" && githubEmpty))) && (
        <label
          htmlFor="ns-deploy"
          // The checkbox fades itself when disabled; the words go quiet beside it.
          className={cn(
            "flex items-center gap-2.5 text-[13px] text-ink-strong transition-colors duration-200",
            deployBlocked && "text-muted-foreground",
          )}
        >
          <Checkbox
            id="ns-deploy"
            checked={deployNow && !deployBlocked}
            disabled={deployBlocked}
            onCheckedChange={(v) => setDeployNow(v === true)}
          />
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
      {error !== null && gitTab && <InternalHostNote error={error} projectId={projectId} />}

      {/* Stays at the bottom while a tall form scrolls (a phone), with a fade above it. */}
      <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 flex justify-end gap-2 bg-popover px-5 pt-3 pb-5 before:pointer-events-none before:absolute before:inset-x-0 before:-top-4 before:h-4 before:bg-linear-to-t before:from-popover before:to-transparent">
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
  const [before, after] = t("newService.pgvectorHint").split("{sql}");
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
          <span className="pl-[26px] text-xs leading-normal text-muted-foreground">
            {before}
            <code className="rounded-chip bg-muted px-1 py-px font-mono text-[11.5px] text-ink-strong">{pgvectorSql}</code>
            {after}
          </span>
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

/** hint: a fixed line under the control (hintText: one already worded); note: one the caller renders (it changes with the value). */
function Field({
  id,
  label,
  hint,
  hintText,
  note,
  children,
}: {
  id: string;
  label: MessageKey;
  hint?: MessageKey;
  hintText?: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  const text = hintText ?? (hint ? t(hint) : null);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{t(label)}</Label>
      {children}
      {text && (
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          {text}
        </span>
      )}
      {note}
    </div>
  );
}
