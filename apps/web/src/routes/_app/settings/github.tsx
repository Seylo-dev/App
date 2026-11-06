// Settings > GitHub: this panel's own GitHub App (created with the manifest
// flow; GitHub sends the browser back here with ?code&state), where it is
// installed, the webhook URL, and the opt-in GitHub account whose token
// clones private repos without the App.

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
import { SectionCard } from "@seylo/ui/components/section-card";
import { toast } from "@seylo/ui/components/toast";
import { IconBrandGithub, IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { DeviceCodePanel } from "../../../components/settings/device-code";
import { formatDate } from "../../../components/settings/format";
import { invalidateOps, useSettingsMutation } from "../../../components/settings/mutation";
import { OpErrorCallout, QueryView, toastError } from "../../../components/settings/op-state";
import { Field, SettingsPage } from "../../../components/settings/page";
import { t } from "../../../i18n/t";

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
      <QueryView query={status}>
        {(data) => (
          <>
            {data.app ? <AppSection data={data} /> : <CreateApp webhookUrl={data.webhookUrl} />}
            <DeviceAccount data={data} />
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

function DeviceAccount({ data }: { data: Status }) {
  const [flow, setFlow] = useState<OpOutput<typeof github.deviceStart> | null>(null);
  const [confirm, setConfirm] = useState(false);
  const start = useSettingsMutation(github.deviceStart, { onSuccess: setFlow });
  const poll = useSettingsMutation(github.devicePoll, { failure: false });
  const disconnect = useSettingsMutation(github.deviceDisconnect, {
    invalidates: refresh,
    success: t("settingsGithub.device.disconnected"),
  });
  const account = data.deviceAccount;

  return (
    <SectionCard
      title={t("settingsGithub.device.title")}
      description={t("settingsGithub.device.description")}
      actions={account && <Chip tone="green">@{account.login}</Chip>}
    >
      {!data.deviceFlowAvailable && !account && <Alert tone="neutral">{t("settingsGithub.device.unavailable")}</Alert>}
      {account && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px]">
            {t("settingsGithub.device.connected", { login: account.login, date: formatDate(account.connectedAt) })}
          </span>
          <span className="flex flex-wrap gap-1">
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
      {data.deviceFlowAvailable && !account && !flow && (
        <div className="flex flex-col gap-3">
          <Alert tone="info">{t("settingsGithub.device.recommendApp")}</Alert>
          <div>
            <Button disabled={start.isPending} onClick={() => start.mutate({})}>
              <IconBrandGithub size={16} stroke={1.8} />
              {t("settingsGithub.device.connect")}
            </Button>
          </div>
        </div>
      )}
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
