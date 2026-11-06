// Settings > Git providers: the panel's GitLab, Gitea/Forgejo and Bitbucket
// connections (one sealed access token each) and the card to add one. The
// token is checked with the provider before it is saved.

import { gitProviders, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { DataTable } from "@seylo/ui/components/data-table";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { IconBrandBitbucket, IconBrandGitlab, IconCup, IconGitBranch } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { invalidateOps, useSettingsMutation } from "../../../components/settings/mutation";
import { errorText, OpErrorCallout } from "../../../components/settings/op-state";
import { Field, FormGrid, SettingRow, SettingsPage } from "../../../components/settings/page";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/git-providers")({
  component: GitProvidersPage,
});

type Provider = OpOutput<typeof gitProviders.list>["items"][number];
type Kind = Provider["kind"];

const refresh = [gitProviders.list];
const icons = { gitlab: IconBrandGitlab, gitea: IconCup, bitbucket: IconBrandBitbucket } as const;

function GitProvidersPage() {
  return (
    <SettingsPage title={t("settingsGitProviders.title")} subtitle={t("settingsGitProviders.subtitle")}>
      <Connections />
      <AddConnection />
    </SettingsPage>
  );
}

function Connections() {
  const list = useOp(gitProviders.list, {});
  const [removing, setRemoving] = useState<Provider | null>(null);
  const update = useSettingsMutation(gitProviders.update, { invalidates: refresh });
  const remove = useSettingsMutation(gitProviders.remove, { invalidates: refresh, success: t("settingsGitProviders.list.removed") });

  return (
    <SectionCard title={t("settingsGitProviders.list.title")} description={t("settingsGitProviders.list.description")} flush>
      {list.error ? (
        <OpErrorCallout error={list.error} onRetry={() => void list.refetch()} className="mx-5 mb-5" />
      ) : (
        <DataTable<Provider>
          bare
          aria-label={t("settingsGitProviders.list.title")}
          loading={list.isPending}
          rows={list.data?.items ?? []}
          getRowId={(p) => p.id}
          empty={
            <EmptyState
              compact
              icon={<IconGitBranch />}
              title={t("settingsGitProviders.list.empty")}
              description={t("settingsGitProviders.list.emptyHint")}
            />
          }
          columns={[
            {
              id: "name",
              header: t("settingsGitProviders.list.name"),
              cell: (p) => {
                const Icon = icons[p.kind];
                return (
                  <span className="flex items-center gap-2">
                    <Icon size={16} stroke={1.8} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="font-medium">{p.name}</span>
                    <Chip tone="gray">{t(`settingsGitProviders.add.kinds.${p.kind}`)}</Chip>
                  </span>
                );
              },
            },
            {
              id: "host",
              header: t("settingsGitProviders.list.host"),
              cell: (p) => <span className="font-mono text-[12.5px]">{p.workspace ? `${p.host}/${p.workspace}` : p.host}</span>,
            },
            {
              id: "account",
              header: t("settingsGitProviders.list.account"),
              cell: (p) => (
                <span className="flex flex-col">
                  <span>{p.account ?? "-"}</span>
                  <span className="text-xs text-muted-foreground">
                    {p.usedBy > 0 ? t("settingsGitProviders.list.usedBy", { count: p.usedBy }) : t("settingsGitProviders.list.unused")}
                  </span>
                </span>
              ),
            },
            {
              id: "status",
              header: t("settingsGitProviders.list.statusNotes"),
              cell: (p) => (
                <Switch
                  checked={p.statusNotes}
                  aria-label={`${t("settingsGitProviders.list.statusNotes")}: ${p.name}`}
                  onCheckedChange={(statusNotes) => update.mutate({ providerId: p.id, statusNotes })}
                />
              ),
            },
            {
              id: "actions",
              header: "",
              align: "right",
              cell: (p) => (
                <span className="flex justify-end gap-1">
                  <CheckButton provider={p} />
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(p)}>
                    {t("settingsGitProviders.list.remove")}
                  </Button>
                </span>
              ),
            },
          ]}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("settingsGitProviders.list.removeTitle", { name: removing?.name ?? "" })}
        description={t("settingsGitProviders.list.removeBody")}
        confirmLabel={t("settingsGitProviders.list.remove")}
        destructive
        onConfirm={() =>
          removing
            ? remove
                .mutateAsync({ providerId: removing.id })
                .then(() => setRemoving(null))
                .catch(() => undefined)
            : Promise.resolve()
        }
      />
    </SectionCard>
  );
}

/** Asks the provider whether the stored token still works (a query, run on click). */
function CheckButton({ provider }: { provider: Provider }) {
  const check = useOp(gitProviders.check, { providerId: provider.id }, { enabled: false, retry: false, gcTime: 0 });
  async function run() {
    const res = await check.refetch();
    if (res.error) toast.error(t("settingsGitProviders.list.checkFailed"), { description: errorText(res.error) });
    else if (res.data?.ok) toast.success(t("settingsGitProviders.list.checkOk"), { description: res.data.message });
    else toast.error(t("settingsGitProviders.list.checkFailed"), { description: res.data?.message ?? "" });
    void invalidateOps(refresh);
  }
  return (
    <Button size="sm" variant="ghost" disabled={check.isFetching} onClick={() => void run()}>
      {check.isFetching ? t("settingsGitProviders.list.checking") : t("settingsGitProviders.list.check")}
    </Button>
  );
}

function AddConnection() {
  const [kind, setKind] = useState<Kind>("gitlab");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://gitlab.com");
  const [workspace, setWorkspace] = useState("");
  const [authKind, setAuthKind] = useState<"token" | "appPassword">("token");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [statusNotes, setStatusNotes] = useState(true);
  const create = useSettingsMutation(gitProviders.create, {
    invalidates: refresh,
    success: (out) => t("settingsGitProviders.add.saved", { account: out.account ?? out.name }),
    onSuccess: () => {
      setName("");
      setToken("");
      setUsername("");
    },
  });

  function pick(next: string) {
    const k = next as Kind;
    setKind(k);
    setUrl(k === "gitlab" ? "https://gitlab.com" : "");
    setAuthKind("token");
  }

  const appPassword = kind === "bitbucket" && authKind === "appPassword";
  const ready =
    name.trim() !== "" &&
    token.trim() !== "" &&
    (kind === "bitbucket" ? workspace.trim() !== "" && (!appPassword || username.trim() !== "") : url.trim().startsWith("https://"));

  return (
    <SectionCard title={t("settingsGitProviders.add.title")} description={t("settingsGitProviders.add.description")}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          create.mutate({
            kind,
            name: name.trim(),
            token: token.trim(),
            statusNotes,
            ...(kind === "bitbucket"
              ? { workspace: workspace.trim(), authKind, ...(appPassword ? { username: username.trim() } : {}) }
              : { url: url.trim().replace(/\/+$/, "") }),
          });
        }}
      >
        <Field label={t("settingsGitProviders.add.kind")}>
          <Segmented
            value={kind}
            onValueChange={(v) => v && pick(v)}
            aria-label={t("settingsGitProviders.add.kind")}
            className="self-start"
          >
            {(["gitlab", "gitea", "bitbucket"] as const).map((k) => {
              const Icon = icons[k];
              return (
                <SegmentedItem key={k} value={k} className="inline-flex items-center gap-1.5 transition-colors duration-200">
                  <Icon size={15} stroke={1.8} aria-hidden="true" />
                  {t(`settingsGitProviders.add.kinds.${k}`)}
                </SegmentedItem>
              );
            })}
          </Segmented>
        </Field>
        <FormGrid>
          <Field label={t("settingsGitProviders.add.name")} htmlFor="gp-name">
            <Input
              id="gp-name"
              value={name}
              placeholder={t("settingsGitProviders.add.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {kind === "bitbucket" ? (
            <Field
              label={t("settingsGitProviders.add.workspace")}
              htmlFor="gp-workspace"
              hint={t("settingsGitProviders.add.workspaceHint")}
            >
              <Input
                id="gp-workspace"
                className="font-mono"
                value={workspace}
                placeholder="acme"
                onChange={(e) => setWorkspace(e.target.value)}
              />
            </Field>
          ) : (
            <Field
              label={t("settingsGitProviders.add.url")}
              htmlFor="gp-url"
              hint={kind === "gitlab" ? t("settingsGitProviders.add.gitlabUrlHint") : t("settingsGitProviders.add.giteaUrlHint")}
            >
              <Input
                id="gp-url"
                className="font-mono"
                value={url}
                placeholder={kind === "gitea" ? "https://git.example.com" : "https://gitlab.com"}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
          )}
          {kind === "bitbucket" && (
            <Field label={t("settingsGitProviders.add.auth")} span>
              <Segmented
                value={authKind}
                onValueChange={(v) => v && setAuthKind(v as "token" | "appPassword")}
                aria-label={t("settingsGitProviders.add.auth")}
                className="self-start"
              >
                <SegmentedItem value="token" className="transition-colors duration-200">
                  {t("settingsGitProviders.add.auths.token")}
                </SegmentedItem>
                <SegmentedItem value="appPassword" className="transition-colors duration-200">
                  {t("settingsGitProviders.add.auths.appPassword")}
                </SegmentedItem>
              </Segmented>
            </Field>
          )}
          {appPassword && (
            <Field label={t("settingsGitProviders.add.username")} htmlFor="gp-username">
              <Input id="gp-username" value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
            </Field>
          )}
          <Field
            label={appPassword ? t("settingsGitProviders.add.password") : t("settingsGitProviders.add.token")}
            htmlFor="gp-token"
            hint={appPassword ? t("settingsGitProviders.add.passwordHint") : t(`settingsGitProviders.add.tokenHint.${kind}`)}
            span={!appPassword}
          >
            <Input
              id="gp-token"
              type="password"
              className="font-mono"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
        </FormGrid>
        <SettingRow
          title={t("settingsGitProviders.add.statusNotes")}
          description={t("settingsGitProviders.add.statusNotesHint")}
          control={<Switch checked={statusNotes} onCheckedChange={setStatusNotes} aria-label={t("settingsGitProviders.add.statusNotes")} />}
        />
        <div>
          <Button type="submit" variant="primary" disabled={!ready || create.isPending}>
            {create.isPending ? t("settingsGitProviders.add.saving") : t("settingsGitProviders.add.save")}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
