// Settings > Git providers: the panel's GitLab, Gitea/Forgejo and Bitbucket
// connections (one sealed access token each) and the card to add one. The
// token is checked with the provider before it is saved.

import { gitProviders, type OpOutput } from "@seylo/ops";
import { useOp, useOpClient } from "@seylo/ops/react";
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
import { Field, FormActions, FormGrid, SettingRow, SettingsPage } from "../../../components/settings/page";
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
  const client = useOpClient();
  const [removing, setRemoving] = useState<Provider | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const update = useSettingsMutation(gitProviders.update, { invalidates: refresh });
  const remove = useSettingsMutation(gitProviders.remove, { invalidates: refresh, success: t("settingsGitProviders.list.removed") });

  /** Asks the provider whether the stored token still works. */
  async function check(provider: Provider) {
    setChecking(provider.id);
    const pending = toast(t("settingsGitProviders.list.checkingToken", { name: provider.name }));
    try {
      const res = await client.call(gitProviders.check, { providerId: provider.id });
      if (res.ok) toast.success(t("settingsGitProviders.list.checkOk"), { description: res.message });
      else toast.error(t("settingsGitProviders.list.checkFailed"), { description: res.message });
    } catch (error) {
      toast.error(t("settingsGitProviders.list.checkFailed"), { description: errorText(error) });
    } finally {
      toast.dismiss(pending);
      setChecking(null);
      void invalidateOps(refresh);
    }
  }

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
          // Check and Delete sit in the row menu like every other settings table, so a phone row keeps them.
          rowActions={(p) => [
            {
              label: checking === p.id ? t("settingsGitProviders.list.checking") : t("settingsGitProviders.list.check"),
              disabled: checking === p.id,
              onSelect: () => void check(p),
            },
            { label: t("settingsGitProviders.list.remove"), destructive: true, separated: true, onSelect: () => setRemoving(p) },
          ]}
          columns={[
            {
              id: "name",
              header: t("settingsGitProviders.list.name"),
              cell: (p) => {
                const Icon = icons[p.kind];
                return (
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
              hideOnMobile: true,
              skeletonWidth: "19.4%",
              cell: (p) => <span className="font-mono text-[12.5px]">{p.workspace ? `${p.host}/${p.workspace}` : p.host}</span>,
            },
            {
              id: "account",
              header: t("settingsGitProviders.list.account"),
              hideOnMobile: true,
              skeletonWidth: "17.4%",
              skeletonLines: 2,
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
              align: "right",
              skeletonWidth: "14.3%",
              cell: (p) => (
                <Switch
                  checked={p.statusNotes}
                  aria-label={`${t("settingsGitProviders.list.statusNotes")}: ${p.name}`}
                  onCheckedChange={(statusNotes) => update.mutate({ providerId: p.id, statusNotes })}
                />
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
                <SegmentedItem key={k} value={k} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <Icon size={15} stroke={1.8} aria-hidden="true" className="max-sm:hidden" />
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
                <SegmentedItem value="token">{t("settingsGitProviders.add.auths.token")}</SegmentedItem>
                <SegmentedItem value="appPassword">{t("settingsGitProviders.add.auths.appPassword")}</SegmentedItem>
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
        <FormActions>
          <Button type="submit" variant="primary" disabled={!ready || create.isPending}>
            {create.isPending ? t("settingsGitProviders.add.saving") : t("settingsGitProviders.add.save")}
          </Button>
        </FormActions>
      </form>
    </SectionCard>
  );
}
