// The page the laptop CLI opens to be signed in (/cli/approve?code=ABCD-EFGH,
// from cliLogin.start's verificationUrl). The person types the code their
// terminal shows; the code in the link never opens the request by itself, so
// a link someone else sends cannot be approved in one click (the device-code
// phishing pattern). Then they see the computer and where the request came
// from, choose what the key may do (nothing is preselected) and approve or
// deny. The key itself goes to the CLI's next poll; this page never sees it.

import { cliLogin, OpError, projects } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Input, Label } from "@seylo/ui/components/input";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { IconTerminal2 } from "@tabler/icons-react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { AuthFrame } from "../components/auth/auth-frame";
import {
  type Access,
  addressDiffers,
  approveInput,
  type ExpiryDays,
  expiryChoices,
  initialChoices,
  type ProjectMode,
} from "../components/cli/approve-choices";
import { normalizeUserCode } from "../components/cli/user-code";
import { QueryError } from "../components/query-error";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/api";
import { formatExpiresIn } from "../lib/format";
import { isReauthCancelled } from "../lib/reauth";
import { ensureViewer, isSignedOut } from "../lib/viewer";

type Request = (typeof cliLogin.CliLoginRequest)["static"];

export const Route = createFileRoute("/cli/approve")({
  // ?code= stays in the URL the CLI opens (and survives the sign-in redirect),
  // but it only changes the hint: the code is always typed.
  validateSearch: (search: Record<string, unknown>): { code?: string } =>
    typeof search.code === "string" && search.code.length > 0 && search.code.length <= 20 ? { code: search.code } : {},
  beforeLoad: async ({ context, location }) => {
    try {
      await ensureViewer(context);
    } catch (error) {
      if (isSignedOut(error)) throw redirect({ to: "/login", search: { redirect: location.href } });
      throw error;
    }
  },
  component: CliApprovePage,
});

function CliApprovePage() {
  const { code: fromLink } = Route.useSearch();
  // The typed code lives here, never in the URL, so no link opens a request ready to approve.
  const [code, setCode] = useState<string | null>(null);
  return (
    <AuthFrame>
      <section aria-label={t("cliLogin.title")} className="flex w-full max-w-[560px] flex-col gap-5 rounded-card bg-card p-7 shadow-card">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-control bg-chip-blue-bg text-chip-blue-fg"
          >
            <IconTerminal2 size={20} stroke={1.8} />
          </span>
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">{t("cliLogin.title")}</h1>
            <p className="m-0 text-[13.5px] leading-normal text-muted-foreground">{t("cliLogin.hint")}</p>
          </div>
        </div>
        {code ? (
          <RequestView code={code} onOtherCode={() => setCode(null)} />
        ) : (
          <EnterCode fromLink={fromLink !== undefined} onCode={setCode} />
        )}
      </section>
    </AuthFrame>
  );
}

function EnterCode({ fromLink, onCode }: { fromLink: boolean; onCode: (code: string) => void }) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const code = normalizeUserCode(value);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (code) onCode(code);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cli-code">{t("cliLogin.enterCode")}</Label>
        <Input
          id="cli-code"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="ABCD-EFGH"
          autoComplete="off"
          autoFocus
          className="font-mono text-[15px] tracking-[0.08em] uppercase"
        />
        <span className="text-xs text-muted-foreground">{t("cliLogin.enterCodeHint")}</span>
      </div>
      <Alert tone="warning">{t(fromLink ? "cliLogin.typeCodeFromLink" : "cliLogin.typeCode")}</Alert>
      {touched && !code && value !== "" && <Alert tone="danger">{t("cliLogin.enterCodeHint")}</Alert>}
      <Button type="submit" variant="primary" className="self-end" disabled={!code}>
        {t("cliLogin.lookUp")}
      </Button>
    </form>
  );
}

function RequestView({ code, onOtherCode }: { code: string; onOtherCode: () => void }) {
  const request = useOp(cliLogin.get, { userCode: code }, { retry: false });
  const [result, setResult] = useState<{ status: "approved"; days: number } | { status: "denied" } | null>(null);

  if (request.isPending) return <Skeleton className="h-64 w-full rounded-card" />;
  if (request.isError) {
    if (request.error instanceof OpError && request.error.code === "NOT_FOUND")
      return (
        <Outcome tone="danger" onOtherCode={onOtherCode}>
          {t("cliLogin.notFound")}
        </Outcome>
      );
    return <QueryError error={request.error} onRetry={() => void request.refetch()} />;
  }
  const r = request.data.request;
  // The address the panel sees this browser at, when the panel reports it
  // (cliLogin.get viewerAddress); older panels leave it out.
  const viewerAddress = (request.data as typeof request.data & { viewerAddress?: string | null }).viewerAddress ?? null;
  const status = result?.status ?? r.status;
  return (
    <>
      <CodeAndComputer request={r} viewerAddress={viewerAddress} />
      {result?.status === "approved" ? (
        <Outcome tone="success" hint={t("cliLogin.done.approvedHint", { days: t("cliLogin.days", { count: result.days }) })}>
          {t("cliLogin.done.approved")}
        </Outcome>
      ) : status === "pending" && Date.parse(r.expiresAt) > Date.now() ? (
        <ApproveForm request={r} onDone={setResult} />
      ) : (
        <Outcome tone={status === "denied" || status === "expired" || status === "pending" ? "neutral" : "success"}>
          {t(`cliLogin.done.${status === "pending" ? "expired" : status}`)}
        </Outcome>
      )}
    </>
  );
}

function CodeAndComputer({ request: r, viewerAddress }: { request: Request; viewerAddress: string | null }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-1.5 rounded-control bg-raised px-4 py-4">
        <span className="text-xs font-medium text-muted-foreground">{t("cliLogin.codeLabel")}</span>
        <output aria-label={t("cliLogin.codeLabel")} className="font-mono text-[28px] font-semibold tracking-[0.14em] text-foreground">
          {r.userCode}
        </output>
        <span className="text-[12.5px] text-muted-foreground">{t("cliLogin.codeCheck")}</span>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13.5px]">
        <dt className="text-muted-foreground">{t("cliLogin.computer")}</dt>
        <dd className="m-0 min-w-0 font-medium [overflow-wrap:anywhere]">{r.clientName}</dd>
        <dt className="text-muted-foreground">{t("cliLogin.requestedFrom")}</dt>
        <dd className="m-0 font-mono text-[13px]">{r.requestedFrom ?? t("cliLogin.unknownAddress")}</dd>
        {viewerAddress && (
          <>
            <dt className="text-muted-foreground">{t("cliLogin.yourAddress")}</dt>
            <dd className="m-0 font-mono text-[13px]">{viewerAddress}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{t("cliLogin.expires")}</dt>
        <dd className="m-0">{formatExpiresIn(r.expiresAt)}</dd>
      </dl>
      <p className="m-0 text-[12.5px] leading-normal text-muted-foreground">{t("cliLogin.computerNote")}</p>
      {addressDiffers(r.requestedFrom, viewerAddress) && <Alert tone="warning">{t("cliLogin.otherAddress")}</Alert>}
    </div>
  );
}

function ApproveForm({
  request: r,
  onDone,
}: {
  request: Request;
  onDone: (result: { status: "approved"; days: number } | { status: "denied" }) => void;
}) {
  const [choices, setChoices] = useState(initialChoices);
  const projectList = useOp(projects.list, {});
  const approve = useOpMutation(cliLogin.approve, { onSuccess: (res) => onDone({ status: "approved", days: res.expiresInDays }) });
  const deny = useOpMutation(cliLogin.deny, { onSuccess: () => onDone({ status: "denied" }) });
  const input = approveInput(r.userCode, choices);
  const busy = approve.isPending || deny.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (input) approve.mutate(input);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-[13px] font-medium">{t("cliLogin.access.label")}</legend>
        {/* No value until the person picks one: full access is never the default. */}
        <RadioGroup
          value={choices.access ?? ""}
          onValueChange={(v) => setChoices((c) => ({ ...c, access: v as Access }))}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          <RadioCard value="readOnly" title={t("cliLogin.access.readOnly")} description={t("cliLogin.access.readOnlyHint")} />
          <RadioCard value="full" title={t("cliLogin.access.full")} description={t("cliLogin.access.fullHint")} />
        </RadioGroup>
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-[13px] font-medium">{t("cliLogin.projects.label")}</legend>
        <RadioGroup
          value={choices.projectMode ?? ""}
          onValueChange={(v) => setChoices((c) => ({ ...c, projectMode: v as ProjectMode }))}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          <RadioCard value="some" title={t("cliLogin.projects.some")} description={t("cliLogin.projects.someHint")} />
          <RadioCard value="all" title={t("cliLogin.projects.all")} description={t("cliLogin.projects.allHint")} />
        </RadioGroup>
        {choices.projectMode === "some" && (
          <div className="flex flex-col gap-1.5 rounded-control bg-raised p-3">
            {projectList.data?.projects.length === 0 && (
              <span className="text-[13px] text-muted-foreground">{t("cliLogin.projects.none")}</span>
            )}
            {projectList.data?.projects.map((project) => {
              const id = `cli-project-${project.id}`;
              return (
                <div key={project.id} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={choices.projectIds.has(project.id)}
                    onCheckedChange={(on) =>
                      setChoices((c) => {
                        const next = new Set(c.projectIds);
                        if (on === true) next.add(project.id);
                        else next.delete(project.id);
                        return { ...c, projectIds: next };
                      })
                    }
                  />
                  <label htmlFor={id} className="cursor-pointer text-[13px]">
                    {project.name}
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cli-expiry">{t("cliLogin.expiry")}</Label>
        <Select value={String(choices.days)} onValueChange={(v) => setChoices((c) => ({ ...c, days: Number(v) as ExpiryDays }))}>
          <SelectTrigger id="cli-expiry" className="sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {expiryChoices.map((choice) => (
              <SelectItem key={choice} value={String(choice)}>
                {t("cliLogin.days", { count: choice })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="m-0 text-[12.5px] leading-normal text-muted-foreground">{t("cliLogin.keyNote", { client: r.clientName })}</p>
      {/* A closed re-auth dialog is not a failure worth a red box. */}
      {((approve.error && !isReauthCancelled(approve.error)) || deny.error) && (
        <Alert tone="danger">{errorMessage(approve.error ?? deny.error, t("common.unknownError"))}</Alert>
      )}
      <div className="flex items-center gap-2">
        <Button disabled={busy} onClick={() => deny.mutate({ userCode: r.userCode })}>
          {t("cliLogin.deny")}
        </Button>
        {!input && <span className="ml-auto text-[12.5px] text-muted-foreground">{t("cliLogin.chooseFirst")}</span>}
        <Button type="submit" variant="primary" className={input ? "ml-auto" : undefined} disabled={busy || !input}>
          {approve.isPending ? t("cliLogin.approving") : t("cliLogin.approve")}
        </Button>
      </div>
    </form>
  );
}

function Outcome({
  tone,
  hint,
  onOtherCode,
  children,
}: {
  tone: "success" | "danger" | "neutral";
  hint?: string;
  onOtherCode?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Alert tone={tone === "neutral" ? "info" : tone}>
        <span className="font-medium">{children}</span>
        {hint && <span className="block text-muted-foreground">{hint}</span>}
      </Alert>
      <div className="flex flex-wrap items-center gap-2">
        {onOtherCode && (
          <Button variant="primary" onClick={onOtherCode}>
            {t("cliLogin.otherCode")}
          </Button>
        )}
        <Button asChild>
          <Link to="/">{t("cliLogin.openDashboard")}</Link>
        </Button>
      </div>
    </div>
  );
}
