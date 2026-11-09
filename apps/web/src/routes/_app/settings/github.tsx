// Settings > GitHub: this panel's own GitHub App (created with the manifest
// flow; GitHub sends the browser back here with ?code&state), where it is
// installed, the webhook URL, and the opt-in connected GitHub account (a
// device login or a pasted token) whose token lists, clones and watches
// private repos the App does not reach, with what organizations need.

import { github, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { CopyField } from "@seylo/ui/components/copy-field";
import { DataTable } from "@seylo/ui/components/data-table";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { KeyValue } from "@seylo/ui/components/key-value";
import { SectionCard, SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { ButtonSkeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { IconBrandGithub, IconExternalLink, IconKey, IconRefresh } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { NumberedSteps } from "../../../components/numbered-steps";
import { DeviceCodePanel } from "../../../components/settings/device-code";
import { formatDate } from "../../../components/settings/format";
import { invalidateOps, useSettingsMutation } from "../../../components/settings/mutation";
import { OpErrorCallout, QueryView, toastError } from "../../../components/settings/op-state";
import { Field, SettingsPage } from "../../../components/settings/page";
import { FieldSkeleton } from "../../../components/settings/skeletons";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";

interface GithubSearch {
  code?: string;
  state?: string;
}

export const Route = createFileRoute("/_app/settings/github")({
  validateSearch: (search: Record<string, unknown>): GithubSearch => ({
    code: typeof search.code === "string" ? search.code : undefined,
    state: typeof search.state === "string" ? search.state : undefined,
  }),
  component: GithubPage,
});

type Status = OpOutput<typeof github.status>;
const refresh = [github.status, github.installations];

function GithubPage() {
  const status = useOp(github.status, {});
  return (
    <SettingsPage title={t("settingsGithub.title")} subtitle={t("settingsGithub.subtitle")}>
      <FinishManifest />
      <QueryView query={status} skeleton={<GithubSkeleton />} className="flex flex-col gap-5">
        {(data) => (
          <>
            {data.app ? <AppSection data={data} /> : <CreateApp webhookUrl={data.webhookUrl} />}
            <AccountSection data={data} />
          </>
        )}
      </QueryView>
    </SettingsPage>
  );
}

/** Back from GitHub after creating the App: exchange the code once, then drop it from the URL. */
function FinishManifest() {
  const { code, state } = Route.useSearch();
  const navigate = useNavigate();
  const started = useRef(false);
  const finish = useSettingsMutation(github.finishManifest, {
    invalidates: refresh,
    success: (app) => t("settingsGithub.created", { name: app.name }),
  });
  useEffect(() => {
    if (!code || !state || started.current) return;
    started.current = true;
    finish.mutate({ code, state }, { onSettled: () => void navigate({ to: "/settings/github", search: {}, replace: true }) });
  }, [code, state, finish, navigate]);
  if (!finish.isPending) return null;
  return <Alert tone="info">{t("settingsGithub.finishing")}</Alert>;
}

function CreateApp({ webhookUrl }: { webhookUrl: string | null }) {
  const [organization, setOrganization] = useState("");
  const start = useSettingsMutation(github.startManifest, {
    onSuccess: (out) => {
      // The manifest flow is a plain form POST to GitHub; it comes back to this page.
      const form = document.createElement("form");
      form.method = "post";
      form.action = out.postUrl;
      const field = document.createElement("input");
      field.type = "hidden";
      field.name = "manifest";
      field.value = out.manifest;
      form.append(field);
      document.body.append(form);
      form.submit();
    },
  });
  return (
    <SectionCard title={t("settingsGithub.app.createTitle")} description={t("settingsGithub.app.createDescription")}>
      {!webhookUrl && <Alert tone="warning">{t("settingsGithub.app.needsAddress")}</Alert>}
      <Field label={t("settingsGithub.app.organization")} hint={t("settingsGithub.app.organizationHint")} htmlFor="gh-org">
        <Input
          id="gh-org"
          value={organization}
          placeholder={t("settings.optional")}
          className="sm:max-w-xs"
          onChange={(e) => setOrganization(e.target.value.replace(/[^A-Za-z0-9-]/g, ""))}
        />
      </Field>
      <div>
        <Button
          variant="primary"
          disabled={start.isPending}
          onClick={() => start.mutate(organization.trim() ? { organization: organization.trim() } : {})}
        >
          <IconBrandGithub size={16} stroke={1.8} />
          {start.isPending ? t("settingsGithub.app.redirecting") : t("settingsGithub.app.create")}
        </Button>
      </div>
    </SectionCard>
  );
}

type Installation = OpOutput<typeof github.installations>["installations"][number];

/** The App card (facts and webhook) and the installations table while the status loads. */
function GithubSkeleton() {
  return (
    <>
      <SectionCardSkeleton titleWidth="w-28" description="w-96" actions={<ButtonSkeleton size="sm" className="w-[132px]" />}>
        <div className="flex flex-col">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex min-h-10 items-center gap-4 border-t border-divider py-2 first:border-t-0">
              <SkeletonText className="w-28 shrink-0 text-[13px] sm:w-36" />
              <SkeletonText className="w-24 text-[13.5px]" />
            </div>
          ))}
        </div>
        <FieldSkeleton labelWidth="w-24" />
      </SectionCardSkeleton>
      <SectionCardSkeleton flush titleWidth="w-28" description="w-80" actions={<ButtonSkeleton size="sm" className="w-44" />}>
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-3 border-t border-divider px-[18px] py-3.5">
            <SkeletonText className="w-24 text-[13px]" />
            <SkeletonText className="w-28 text-[13px]" />
            <SkeletonText className="ml-auto w-28 text-[13px]" />
          </div>
        ))}
      </SectionCardSkeleton>
    </>
  );
}

function AppSection({ data }: { data: Status }) {
  const app = data.app;
  const installs = useOp(github.installations, {});
  const sync = useSettingsMutation(github.syncInstallations, { invalidates: refresh, success: t("settingsGithub.app.synced") });
  const remove = useSettingsMutation(github.deleteApp, { invalidates: refresh, success: t("settingsGithub.app.forgotten") });
  const [confirm, setConfirm] = useState(false);
  if (!app) return null;
  return (
    <>
      <SectionCard
        title={app.name}
        description={t("settingsGithub.app.description")}
        actions={
          <Button asChild size="sm">
            <a href={app.htmlUrl} target="_blank" rel="noreferrer">
              <IconExternalLink size={15} stroke={1.8} />
              {t("settingsGithub.app.openOnGithub")}
            </a>
          </Button>
        }
      >
        <KeyValue
          items={[
            { label: t("settingsGithub.app.owner"), value: app.ownerLogin },
            { label: t("settingsGithub.app.appId"), value: String(app.appId), mono: true },
            { label: t("settingsGithub.app.createdAt"), value: formatDate(app.createdAt) },
          ]}
        />
        <Field label={t("settingsGithub.webhook")} hint={t("settingsGithub.webhookHint")}>
          {data.webhookUrl ? (
            <CopyField value={data.webhookUrl} aria-label={t("settingsGithub.webhook")} />
          ) : (
            <Alert tone="warning">{t("settingsGithub.app.needsAddress")}</Alert>
          )}
        </Field>
      </SectionCard>

      <SectionCard
        title={t("settingsGithub.installs.title")}
        description={t("settingsGithub.installs.description")}
        flush
        actions={
          <>
            <Button size="sm" disabled={sync.isPending} onClick={() => sync.mutate({})}>
              <IconRefresh size={15} stroke={1.8} />
              {t("settingsGithub.installs.sync")}
            </Button>
            <Button asChild size="sm" variant="primary">
              <a href={installs.data?.installUrl ?? app.installUrl} target="_blank" rel="noreferrer">
                {t("settingsGithub.installs.install")}
              </a>
            </Button>
          </>
        }
      >
        {installs.error ? (
          <OpErrorCallout error={installs.error} onRetry={() => void installs.refetch()} className="mx-5 mb-5" />
        ) : (
          <DataTable<Installation>
            bare
            aria-label={t("settingsGithub.installs.title")}
            loading={installs.isPending}
            rows={installs.data?.installations ?? []}
            getRowId={(i) => i.id}
            empty={<EmptyState compact icon={<IconBrandGithub />} title={t("settingsGithub.installs.empty")} />}
            columns={[
              {
                id: "account",
                header: t("settingsGithub.installs.account"),
                cell: (i) => (
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{i.accountLogin}</span>
                    <Chip tone="gray">{t(`settingsGithub.installs.types.${i.accountType}`)}</Chip>
                    {i.suspended && <Chip tone="red">{t("settingsGithub.installs.suspended")}</Chip>}
                  </span>
                ),
              },
              {
                id: "repos",
                header: t("settingsGithub.installs.repos"),
                cell: (i) => t(`settingsGithub.installs.selection.${i.repositorySelection}`),
              },
              {
                id: "manage",
                header: "",
                align: "right",
                cell: (i) => (
                  <a href={i.manageUrl} target="_blank" rel="noreferrer" className="text-[12.5px] text-link hover:text-link-hover">
                    {t("settingsGithub.installs.manage")}
                  </a>
                ),
              },
            ]}
          />
        )}
      </SectionCard>

      <SectionCard title={t("settingsGithub.app.dangerTitle")} danger description={t("settingsGithub.app.dangerDescription")}>
        <div>
          <Button variant="destructive" onClick={() => setConfirm(true)}>
            {t("settingsGithub.app.forget")}
          </Button>
        </div>
      </SectionCard>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("settingsGithub.app.forgetTitle", { name: app.name })}
        description={t("settingsGithub.app.forgetDescription")}
        confirmLabel={t("settingsGithub.app.forget")}
        confirmText={app.slug}
        destructive
        onConfirm={() => remove.mutateAsync({ confirm: true }).then(() => undefined)}
      />
    </>
  );
}

/**
 * "Private repositories without the App": the panel's connected GitHub
 * account, from a device login or a pasted token, the same card either way
 * once connected, and what organizations need.
 */
function AccountSection({ data }: { data: Status }) {
  const [flow, setFlow] = useState<OpOutput<typeof github.deviceStart> | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const start = useSettingsMutation(github.deviceStart, { onSuccess: setFlow });
  const poll = useSettingsMutation(github.devicePoll, { failure: false });
  const disconnect = useSettingsMutation(github.deviceDisconnect, {
    invalidates: refresh,
    success: t("settingsGithub.device.disconnected"),
  });
  const account = data.account;

  return (
    <SectionCard
      title={t("settingsGithub.device.title")}
      description={t("settingsGithub.device.description")}
      actions={account && <Chip tone="green">@{account.login}</Chip>}
    >
      {account && (
        <div data-testid="github-account" className="flex flex-wrap items-center gap-3">
          <span className="text-[13px]">
            {t("settingsGithub.device.connected", { login: account.login, date: formatDate(account.connectedAt) })}
          </span>
          <span className="flex flex-wrap gap-1">
            <Chip tone="gray">{t(account.method === "token" ? "settingsGithub.device.viaToken" : "settingsGithub.device.viaDevice")}</Chip>
            {account.tokenKind === "fineGrained" && <Chip tone="gray">{t("settingsGithub.device.fineGrained")}</Chip>}
            {account.scopes.map((scope) => (
              <Chip key={scope} tone="gray" mono>
                {scope}
              </Chip>
            ))}
          </span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setConfirm(true)}>
            {t("settingsGithub.device.disconnect")}
          </Button>
        </div>
      )}
      {!account && !flow && !tokenOpen && (
        <div className="flex flex-col gap-3">
          <Alert tone="info">{t("settingsGithub.device.recommendApp")}</Alert>
          {!data.deviceFlowAvailable && <Alert tone="neutral">{t("settingsGithub.device.unavailable")}</Alert>}
          <div className="flex flex-wrap gap-2">
            {data.deviceFlowAvailable && (
              <Button disabled={start.isPending} onClick={() => start.mutate({})}>
                <IconBrandGithub size={16} stroke={1.8} />
                {t("settingsGithub.device.connect")}
              </Button>
            )}
            <Button onClick={() => setTokenOpen(true)}>
              <IconKey size={16} stroke={1.8} />
              {t("settingsGithub.device.useToken")}
            </Button>
          </div>
        </div>
      )}
      {!account && tokenOpen && <TokenForm onDone={() => setTokenOpen(false)} onCancel={() => setTokenOpen(false)} />}
      {flow && (
        <DeviceCodePanel
          code={flow}
          poll={async () => (await poll.mutateAsync({ flowId: flow.flowId })).status}
          onCancel={() => setFlow(null)}
          onFinish={(result, error) => {
            setFlow(null);
            if (result === "done") {
              toast.success(t("settingsGithub.device.connectedToast"));
              void invalidateOps(refresh);
            } else if (result === "error") toastError(error);
            else toast.warning(t(`settingsSecurity.device.${result}`));
          }}
        />
      )}
      <OrgAccess />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("settingsGithub.device.disconnectTitle")}
        description={t("settingsGithub.device.disconnectDescription")}
        confirmLabel={t("settingsGithub.device.disconnect")}
        destructive
        onConfirm={() => disconnect.mutateAsync({}).then(() => undefined)}
      />
    </SectionCard>
  );
}

const tokensPage = "https://github.com/settings/tokens";

/** "Use a token": the steps, a link to GitHub's token page and the field; the panel checks the token before it saves it. */
function TokenForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [token, setToken] = useState("");
  const save = useSettingsMutation(github.tokenConnect, {
    invalidates: refresh,
    failure: false,
    success: (account) => t("settingsGithub.token.saved", { login: account.login }),
    onSuccess: onDone,
  });
  const [before, after] = t("settingsGithub.token.step1").split("{link}");
  const trimmed = token.trim();
  return (
    <form
      data-testid="github-token-form"
      className="flex flex-col gap-4 rounded-control bg-raised p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed.length >= 20) save.mutate({ token: trimmed });
      }}
    >
      <span className="text-[13.5px] font-medium text-foreground">{t("settingsGithub.token.title")}</span>
      <NumberedSteps
        steps={[
          <>
            {before}
            <a href={tokensPage} target="_blank" rel="noreferrer" className="font-medium text-link hover:text-link-hover">
              {t("settingsGithub.token.link")}
              <IconExternalLink size={12} stroke={1.8} className="ml-0.5 inline align-[-1px]" aria-hidden="true" />
            </a>
            {after}
          </>,
          t("settingsGithub.token.step2"),
          t("settingsGithub.token.step3"),
          t("settingsGithub.token.step4"),
        ]}
      />
      <Field label={t("settingsGithub.token.label")} htmlFor="gh-token">
        <Input
          id="gh-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            save.reset();
          }}
          placeholder={t("settingsGithub.token.placeholder")}
          aria-invalid={save.isError}
          aria-describedby={save.isError ? "gh-token-error" : undefined}
          className="font-mono sm:max-w-md"
        />
        {save.isError && (
          <span id="gh-token-error" role="alert" className="text-[12.5px] leading-normal text-destructive">
            {errorMessage(save.error, t("common.unknownError"))}
          </span>
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={trimmed.length < 20 || save.isPending}>
          {save.isPending ? t("settingsGithub.token.checking") : t("settingsGithub.token.save")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

/** Why an organization's private repositories may not show for a connected account, and how the App avoids it. */
function OrgAccess() {
  const [before, after] = t("settingsGithub.orgs.body").split("{url}");
  return (
    <div className="flex flex-col gap-1 pt-1">
      <span className="text-[13px] font-medium text-ink-strong">{t("settingsGithub.orgs.title")}</span>
      <p className="m-0 text-[12.5px] leading-relaxed text-muted-foreground">
        {before}
        <code className="rounded-chip bg-muted px-1 py-px font-mono text-[11.5px] break-all text-ink-strong">
          {t("settingsGithub.orgs.url")}
        </code>
        {after}
      </p>
    </div>
  );
}
