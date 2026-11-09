// First run (Setup.dc.html), opened from the one-time /setup?t=<token>
// link the installer prints. Steps come from setup.status:
//   owner           email and password, or GitHub (device flow)
//   panelDomain     the panel's name and, optionally, its domain
//   wildcardDomain  the first node's wildcard domain for automatic domains
//   firstProject    a first project
// Every step after the owner can be skipped; setup.finish records which.

import { slug } from "@seylo/brand";
import { auth, nodes, OpError, projects, settings, setup } from "@seylo/ops";
import { opQueryKey, useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { Input, Label } from "@seylo/ui/components/input";
import { EnterOnChange } from "@seylo/ui/components/motion";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconCheck } from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { AuthFrame } from "../components/auth/auth-frame";
import { DeviceCodeCard, type DeviceCodeView, GitHubMark, useDevicePolling } from "../components/auth/device-code";
import { QueryError } from "../components/query-error";
import { loadProgress, saveProgress } from "../components/setup/progress";
import { type MessageKey, t } from "../i18n/t";
import { errorMessage, opClient, queryClient } from "../lib/api";
import { formatExpiresIn } from "../lib/format";
import { refreshBoot } from "../lib/theme";

type Step = "owner" | "panelDomain" | "wildcardDomain" | "firstProject";

const stepLabels: Record<Step, MessageKey> = {
  owner: "setup.stepOwner",
  panelDomain: "setup.stepPanelDomain",
  wildcardDomain: "setup.stepWildcard",
  firstProject: "setup.stepProject",
};

const hostnamePattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const Route = createFileRoute("/setup")({
  validateSearch: (search: Record<string, unknown>): { t?: string } =>
    typeof search.t === "string" && search.t.length > 0 && search.t.length <= 200 ? { t: search.t } : {},
  component: SetupPage,
});

function SetupPage() {
  const { t: token } = Route.useSearch();
  const status = useOp(setup.status, { token }, { retry: false });
  const viewer = useOp(auth.whoami, {}, { retry: false });
  const [step, setStep] = useState<Step | null>(null);
  const [skipped, setSkipped] = useState<Step[]>([]);
  const [finishing, setFinishing] = useState(false);
  const steps = (status.data?.steps ?? ["owner", "panelDomain", "wildcardDomain", "firstProject"]) as Step[];
  const signedIn = viewer.isSuccess;

  // Where to start: after the owner step as soon as someone is signed in,
  // or where this tab was before a reload.
  useEffect(() => {
    if (step || !status.data) return;
    if (!status.data.ownerExists) setStep("owner");
    else if (signedIn && !status.data.completed) {
      const saved = loadProgress(steps);
      setStep((saved?.step as Step | undefined) ?? steps[1] ?? "firstProject");
      if (saved) setSkipped(saved.skipped as Step[]);
    }
  }, [step, status.data, signedIn, steps]);

  const next = (from: Step, skip = false) => {
    const nextSkipped = skip ? [...skipped, from] : skipped;
    setSkipped(nextSkipped);
    const index = steps.indexOf(from);
    const following = steps[index + 1] ?? null;
    setStep(following);
    saveProgress(following ? { step: following, skipped: nextSkipped } : null);
    if (index === steps.length - 1) setFinishing(true);
  };

  let body: ReactNode;
  if (status.isPending || viewer.isPending) body = <Skeleton className="h-72 w-full max-w-[920px] rounded-card" />;
  else if (status.isError)
    body = <QueryError error={status.error} className="w-full max-w-[560px]" onRetry={() => void status.refetch()} />;
  else if (finishing) body = <Finish skipped={skipped} />;
  else if (status.data.completed && !step) body = <AlreadyDone signedIn={signedIn} />;
  else if (!status.data.ownerExists && !(status.data.link?.valid ?? false)) body = <BadLink />;
  else if (status.data.ownerExists && !signedIn) body = <OwnerExists token={token} />;
  else if (step === "owner")
    body = (
      <OwnerStep
        token={token ?? ""}
        expiresAt={status.data.link?.expiresAt ?? null}
        githubAvailable={status.data.githubAvailable}
        onDone={() => next("owner")}
      />
    );
  else if (step === "panelDomain") body = <PanelStep onDone={(skip) => next("panelDomain", skip)} />;
  else if (step === "wildcardDomain") body = <WildcardStep onDone={(skip) => next("wildcardDomain", skip)} />;
  else if (step === "firstProject") body = <ProjectStep onDone={(skip) => next("firstProject", skip)} />;
  else body = <Skeleton className="h-72 w-full max-w-[920px] rounded-card" />;

  const current = finishing ? steps.length : step ? steps.indexOf(step) : 0;
  return (
    <AuthFrame>
      {/*
        A progress line, not tabs: numbered dots joined by a thin line, the current step's name in
        full color. The steps are not links (they looked like a segmented control you could click).
        On a phone only the current step's name shows.
      */}
      <ol aria-label={t("setup.steps")} className="m-0 flex list-none items-center justify-center gap-2 p-0 text-[12.5px]">
        {steps.map((item, index) => (
          <li key={item} aria-current={index === current ? "step" : undefined} className="flex items-center gap-2">
            {index > 0 && (
              <span
                aria-hidden="true"
                className={cn("h-px w-5 transition-colors duration-200 sm:w-8", index <= current ? "bg-primary" : "bg-control-off")}
              />
            )}
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-medium transition-colors duration-200",
                index <= current ? "bg-primary text-primary-foreground" : "bg-track text-ink-strong",
              )}
            >
              {index < current ? <IconCheck size={12} stroke={3} aria-label={t("setup.stepDone")} /> : index + 1}
            </span>
            <span
              className={cn(
                "whitespace-nowrap transition-colors duration-200",
                index === current ? "text-foreground" : "text-muted-foreground max-md:sr-only",
              )}
            >
              {t(stepLabels[item])}
            </span>
          </li>
        ))}
      </ol>
      {/* Each step fades in as the one before it is done, like a tab's screen. */}
      <EnterOnChange motionKey={finishing ? "finish" : (step ?? "")} className="flex w-full flex-col items-center">
        {body}
      </EnterOnChange>
    </AuthFrame>
  );
}

function Panel({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <section
      aria-label={label}
      className={cn("flex min-w-0 flex-[1_1_400px] flex-col gap-4 rounded-card bg-card p-7 shadow-card", className)}
    >
      {children}
    </section>
  );
}

function Heading({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
      {hint && <p className="m-0 text-[13.5px] leading-normal text-muted-foreground">{hint}</p>}
    </div>
  );
}

function signedInAs(viewer: { id: string; email: string; name: string; role: "owner" | "admin" | "member" }) {
  queryClient.setQueryData(opQueryKey(auth.whoami, {}), { viewer, via: "session" });
}

function OwnerStep({
  token,
  expiresAt,
  githubAvailable,
  onDone,
}: {
  token: string;
  expiresAt: string | null;
  githubAvailable: boolean;
  onDone: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repoAccess, setRepoAccess] = useState(false);
  const [device, setDevice] = useState<DeviceCodeView | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const create = useOpMutation(setup.createOwner, {
    onSuccess: ({ viewer }) => {
      signedInAs(viewer);
      onDone();
    },
  });
  const githubStart = useOpMutation(setup.githubStart, {
    onSuccess: (code) => {
      setGithubError(null);
      setDevice(code);
      window.open(code.verificationUri, "_blank", "noopener");
    },
    onError: (error) => setGithubError(errorMessage(error, t("common.unknownError"))),
  });
  useDevicePolling(
    device,
    (ticket) => opClient.call(setup.githubPoll, { token, ticket }),
    (result) => {
      if (result.status === "done" && result.viewer) {
        signedInAs(result.viewer);
        return onDone();
      }
      setDevice(null);
      setGithubError(t(result.status === "denied" ? "auth.github.denied" : "auth.github.expired"));
    },
    (error) => {
      setDevice(null);
      setGithubError(errorMessage(error, t("common.unknownError")));
    },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ token, email: email.trim(), password });
  };

  return (
    <div className={cn("flex w-full flex-wrap items-stretch gap-4", githubAvailable ? "max-w-[920px]" : "max-w-[560px]")}>
      <Panel label={t("setup.title")}>
        <Heading
          title={t("setup.title")}
          hint={expiresAt ? t("setup.linkHint", { expires: formatExpiresIn(expiresAt) }) : t("setup.linkHintNoExpiry")}
        />
        {githubAvailable && (
          <>
            <Button
              variant="dark"
              disabled={githubStart.isPending || device !== null}
              onClick={() => githubStart.mutate({ token, repoAccess })}
            >
              <GitHubMark />
              {t("auth.github.continue")}
            </Button>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-divider" />
              {t("setup.orEmail")}
              <span className="h-px flex-1 bg-divider" />
            </div>
          </>
        )}
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="owner-email">{t("auth.email")}</Label>
            <Input
              id="owner-email"
              type="email"
              autoComplete="username"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="owner-password">{t("auth.password")}</Label>
            <Input
              id="owner-password"
              type="password"
              autoComplete="new-password"
              placeholder={t("setup.passwordHint")}
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {create.error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {errorMessage(create.error, t("common.unknownError"))}
            </p>
          )}
          <Button type="submit" variant="primary" className="mt-0.5" disabled={create.isPending || password.length < 10}>
            {t("setup.createAccount")}
          </Button>
        </form>
        <p className="m-0 text-xs text-muted-foreground">{t("setup.twoFactorLater")}</p>
      </Panel>

      {githubAvailable && (
        <Panel label={t("setup.githubTitle")}>
          <div className="flex flex-col gap-1.5">
            <Chip tone="blue" className="self-start text-[11.5px]">
              {t("setup.afterGithub")}
            </Chip>
            <h2 className="m-0 text-lg font-semibold tracking-[-0.01em]">{t("setup.githubTitle")}</h2>
            <p className="m-0 text-[13px] leading-normal text-muted-foreground">{t("setup.githubHint")}</p>
          </div>
          {device ? (
            <DeviceCodeCard code={device} waiting />
          ) : (
            <div
              className="flex items-center justify-center rounded-card px-4 py-7 text-[13px] text-muted-foreground"
              style={{ background: "var(--highlight)" }}
            >
              {t("setup.githubIdle")}
            </div>
          )}
          {githubError && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {githubError}
            </p>
          )}
          <label
            htmlFor="repo-access"
            className="flex items-start gap-2.5 border-t border-divider pt-3.5 text-[12.5px] leading-normal text-ink-strong"
          >
            <Checkbox
              id="repo-access"
              checked={repoAccess}
              onCheckedChange={(value) => setRepoAccess(value === true)}
              disabled={device !== null}
              className="mt-0.5"
            />
            {t("setup.repoAccess")}
          </label>
        </Panel>
      )}
    </div>
  );
}

function PanelStep({ onDone }: { onDone: (skipped: boolean) => void }) {
  const general = useOp(settings.general, {});
  const nodeList = useOp(nodes.list, {}, { retry: false });
  const [name, setName] = useState<string | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const update = useOpMutation(settings.updateGeneral, {
    onSuccess: () => {
      void refreshBoot();
      onDone(false);
    },
  });
  const panelNode = nodeList.data?.nodes.find((node) => node.isPanelNode);
  const nameValue = name ?? general.data?.name ?? "";
  const domainValue = (domain ?? general.data?.domain ?? "").trim().toLowerCase();
  const domainValid = domainValue === "" || hostnamePattern.test(domainValue);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ name: nameValue.trim() || undefined, domain: domainValue || null });
  };

  return (
    <Panel label={t("setup.stepPanelDomain")} className="w-full max-w-[560px] flex-none">
      <Heading title={t("setup.panelTitle")} hint={t("setup.panelHint")} />
      {general.isError ? (
        <>
          <QueryError error={general.error} onRetry={() => void general.refetch()} />
          <SkipOnly onSkip={() => onDone(true)} />
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="panel-name">{t("setup.panelName")}</Label>
            <Input
              id="panel-name"
              value={nameValue}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              disabled={general.isPending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="panel-domain">{t("setup.panelDomain")}</Label>
            <Input
              id="panel-domain"
              value={domain ?? general.data?.domain ?? ""}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="panel.example.com"
              aria-invalid={!domainValid}
              className="font-mono"
              disabled={general.isPending}
            />
            <span className="text-xs leading-normal text-muted-foreground">
              {panelNode && aRecordIp(panelNode)
                ? t("setup.panelDomainDns", { ip: aRecordIp(panelNode) as string })
                : t("setup.panelDomainHint")}
            </span>
          </div>
          {general.data && <span className="text-xs text-muted-foreground">{t("setup.reachableAt", { url: general.data.publicUrl })}</span>}
          {update.error && <Alert tone="danger">{errorMessage(update.error, t("common.unknownError"))}</Alert>}
          <StepButtons pending={update.isPending} disabled={!domainValid || general.isPending} onSkip={() => onDone(true)} />
        </form>
      )}
    </Panel>
  );
}

function WildcardStep({ onDone }: { onDone: (skipped: boolean) => void }) {
  const nodeList = useOp(nodes.list, {});
  const [wildcard, setWildcard] = useState<string | null>(null);
  const update = useOpMutation(nodes.updateSettings, { onSuccess: () => onDone(false) });
  const node = nodeList.data?.nodes.find((item) => item.isPanelNode) ?? nodeList.data?.nodes[0];
  const value = (wildcard ?? node?.wildcardDomain ?? "").trim().toLowerCase().replace(/^\*\./, "");
  const valid = value === "" || hostnamePattern.test(value);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!node) return;
    if (value === (node.wildcardDomain ?? "")) return onDone(value === "");
    update.mutate({ nodeId: node.id, wildcardDomain: value || null });
  };

  return (
    <Panel label={t("setup.stepWildcard")} className="w-full max-w-[560px] flex-none">
      <Heading title={t("setup.wildcardTitle")} hint={t("setup.wildcardHint")} />
      {nodeList.isError ? (
        <>
          <QueryError error={nodeList.error} onRetry={() => void nodeList.refetch()} />
          <SkipOnly onSkip={() => onDone(true)} />
        </>
      ) : !node ? (
        nodeList.isPending ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            <Alert tone="warning">{t("setup.noNode")}</Alert>
            <SkipOnly onSkip={() => onDone(true)} />
          </>
        )
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <div className="flex items-center gap-2.5 rounded-control bg-raised px-3.5 py-3 text-[13px]">
            <StatusDot status={node.status === "online" ? "ok" : "off"} />
            <span className="font-medium">{node.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{node.publicAddress ?? node.publicIpv4}</span>
            <Chip tone={node.status === "online" ? "green" : "gray"} className="ml-auto">
              {t(`nodes.status.${node.status}`)}
            </Chip>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wildcard">{t("nodes.form.wildcard")}</Label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px] text-muted-foreground">*.</span>
              <Input
                id="wildcard"
                value={wildcard ?? node.wildcardDomain ?? ""}
                onChange={(e) => setWildcard(e.target.value)}
                placeholder="de1.example.com"
                aria-invalid={!valid}
                className="font-mono"
              />
            </div>
          </div>
          {value && valid && (
            <p className="m-0 text-[12.5px] leading-[1.7] text-ink-strong">
              {t("nodes.addCard.dnsBefore")}{" "}
              <span className="rounded-chip bg-muted px-[7px] py-0.5 font-mono text-xs text-foreground">
                *.{value} A {aRecordIp(node) ?? t("setup.nodeIp")}
              </span>{" "}
              {t("nodes.addCard.dnsAfter")}{" "}
              <a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer" className="font-medium">
                {t("nodes.addCard.cloudflare")}
              </a>
            </p>
          )}
          {update.error && <Alert tone="danger">{errorMessage(update.error, t("common.unknownError"))}</Alert>}
          <StepButtons pending={update.isPending} disabled={!valid} onSkip={() => onDone(true)} />
        </form>
      )}
    </Panel>
  );
}

function ProjectStep({ onDone }: { onDone: (skipped: boolean) => void }) {
  const [name, setName] = useState("");
  const create = useOpMutation(projects.create, { onSuccess: () => onDone(false) });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ name: name.trim() });
  };
  return (
    <Panel label={t("setup.stepProject")} className="w-full max-w-[560px] flex-none">
      <Heading title={t("setup.projectTitle")} hint={t("setup.projectHint")} />
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="first-project">{t("project.name")}</Label>
          <Input id="first-project" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="my-app" autoFocus />
        </div>
        {create.error && <Alert tone="danger">{errorMessage(create.error, t("common.unknownError"))}</Alert>}
        <StepButtons pending={create.isPending} disabled={name.trim() === ""} onSkip={() => onDone(true)} label="setup.createProject" />
      </form>
    </Panel>
  );
}

function Finish({ skipped }: { skipped: Step[] }) {
  const navigate = useNavigate();
  const finish = useOpMutation(setup.finish, {
    onSuccess: () => {
      saveProgress(null);
      void navigate({ to: "/" });
    },
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once when the last step is done
  useEffect(() => {
    finish.mutate({ skipped });
  }, []);
  return (
    <Panel label={t("setup.doneTitle")} className="w-full max-w-[560px] flex-none items-start">
      <Heading title={t("setup.doneTitle")} hint={t("setup.doneHint")} />
      {finish.error && <QueryError error={finish.error} onRetry={() => finish.mutate({ skipped })} />}
      {finish.error instanceof OpError && finish.error.code === "NOT_IMPLEMENTED" && (
        <Button variant="primary" asChild>
          <Link to="/">{t("setup.openDashboard")}</Link>
        </Button>
      )}
    </Panel>
  );
}

function StepButtons({
  pending,
  disabled,
  onSkip,
  label = "common.next",
}: {
  pending: boolean;
  disabled: boolean;
  onSkip: () => void;
  label?: MessageKey;
}) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <Button variant="ghost" onClick={onSkip}>
        {t("setup.skipStep")}
      </Button>
      <Button type="submit" variant="primary" className="ml-auto" disabled={pending || disabled}>
        {t(label)}
      </Button>
    </div>
  );
}

function SkipOnly({ onSkip }: { onSkip: () => void }) {
  return (
    <Button variant="ghost" className="self-start" onClick={onSkip}>
      {t("setup.skipStep")}
    </Button>
  );
}

function BadLink() {
  return (
    <Panel label={t("setup.badLinkTitle")} className="w-full max-w-[560px] flex-none">
      <Heading title={t("setup.badLinkTitle")} hint={t("setup.badLinkHint")} />
      <CodeBlock code={`${slug} panel setup-link`} tone="dark" />
    </Panel>
  );
}

function OwnerExists({ token }: { token: string | undefined }) {
  return (
    <Panel label={t("setup.ownerExistsTitle")} className="w-full max-w-[560px] flex-none items-start">
      <Heading title={t("setup.ownerExistsTitle")} hint={t("setup.ownerExistsHint")} />
      <Button variant="primary" asChild>
        <Link to="/login" search={{ redirect: token ? `/setup?t=${encodeURIComponent(token)}` : "/setup" }}>
          {t("auth.submit")}
        </Link>
      </Button>
    </Panel>
  );
}

function AlreadyDone({ signedIn }: { signedIn: boolean }) {
  return (
    <Panel label={t("setup.completedTitle")} className="w-full max-w-[560px] flex-none items-start">
      <Heading title={t("setup.completedTitle")} hint={t("setup.completedHint")} />
      <Button variant="primary" asChild>
        <Link to={signedIn ? "/" : "/login"}>{signedIn ? t("setup.openDashboard") : t("auth.submit")}</Link>
      </Button>
    </Panel>
  );
}

/** The IPv4 an A record points at: the node's public address when it is one, else the detected IPv4. */
function aRecordIp(node: { publicAddress: string | null; publicIpv4: string | null }): string | null {
  return node.publicAddress && /^\d+\.\d+\.\d+\.\d+$/.test(node.publicAddress) ? node.publicAddress : node.publicIpv4;
}
