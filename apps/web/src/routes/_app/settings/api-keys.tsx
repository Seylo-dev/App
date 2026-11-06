// Settings > API keys and MCP: scoped API keys for scripts and CI, and the
// MCP server for model hosts (its URL, config snippets, tokens and the
// OAuth clients that connected). MCP is read-only by default; anything
// that changes something waits for a person in Approvals.

import { auth, mcp, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { CopyField } from "@seylo/ui/components/copy-field";
import { DataTable } from "@seylo/ui/components/data-table";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { Switch } from "@seylo/ui/components/switch";
import { IconPlugConnected, IconPlus } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { formatRelative } from "../../../components/settings/format";
import { KeySheet } from "../../../components/settings/keys/key-sheet";
import { KeyTable } from "../../../components/settings/keys/key-table";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { OpErrorCallout, QueryView } from "../../../components/settings/op-state";
import { SettingRow, SettingsPage } from "../../../components/settings/page";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/api-keys")({
  component: KeysPage,
});

function KeysPage() {
  const me = useOp(auth.whoami, {});
  const isAdmin = me.data?.viewer.role === "owner" || me.data?.viewer.role === "admin";
  return (
    <SettingsPage title={t("settingsKeys.title")} subtitle={t("settingsKeys.subtitle")}>
      <ApiKeysSection isAdmin={isAdmin} />
      <McpSection isAdmin={isAdmin} />
    </SettingsPage>
  );
}

type Whose = "mine" | "everyone";

function KeyFilters({
  isAdmin,
  whose,
  setWhose,
  revoked,
  setRevoked,
}: {
  isAdmin: boolean;
  whose: Whose;
  setWhose: (w: Whose) => void;
  revoked: boolean;
  setRevoked: (v: boolean) => void;
}) {
  const revokedId = useId();
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 pb-3">
      {isAdmin && (
        <Segmented value={whose} onValueChange={(v) => setWhose(v as Whose)} aria-label={t("settingsKeys.whose")}>
          <SegmentedItem value="mine">{t("settingsKeys.mine")}</SegmentedItem>
          <SegmentedItem value="everyone">{t("settingsKeys.everyone")}</SegmentedItem>
        </Segmented>
      )}
      <label htmlFor={revokedId} className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
        <Switch id={revokedId} size="sm" checked={revoked} onCheckedChange={setRevoked} />
        {t("settingsKeys.showRevoked")}
      </label>
    </div>
  );
}

function ApiKeysSection({ isAdmin }: { isAdmin: boolean }) {
  const [creating, setCreating] = useState(false);
  const [whose, setWhose] = useState<Whose>("mine");
  const [revoked, setRevoked] = useState(false);
  return (
    <SectionCard
      title={t("settingsKeys.api.title")}
      description={t("settingsKeys.api.description")}
      flush
      actions={
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          <IconPlus size={15} stroke={1.8} />
          {t("settingsKeys.api.create")}
        </Button>
      }
    >
      <KeyFilters isAdmin={isAdmin} whose={whose} setWhose={setWhose} revoked={revoked} setRevoked={setRevoked} />
      <KeyTable kind="api" everyone={whose === "everyone"} includeRevoked={revoked} empty={t("settingsKeys.api.empty")} />
      <KeySheet kind="api" open={creating} onOpenChange={setCreating} />
    </SectionCard>
  );
}

type McpInfo = OpOutput<typeof mcp.info>;

function McpSection({ isAdmin }: { isAdmin: boolean }) {
  const info = useOp(mcp.info, {});
  return (
    <>
      <SectionCard title={t("settingsKeys.mcp.title")} description={t("settingsKeys.mcp.description")}>
        <QueryView query={info}>{(data) => <McpServer data={data} isAdmin={isAdmin} />}</QueryView>
      </SectionCard>
      <McpTokens isAdmin={isAdmin} />
      {isAdmin && <McpClients />}
    </>
  );
}

const snippetHosts = ["claude-code", "claude-desktop", "cursor"] as const;
type SnippetHost = (typeof snippetHosts)[number];

function hostLabel(host: string): string {
  return (snippetHosts as readonly string[]).includes(host) ? t(`settingsKeys.mcp.hosts.${host as SnippetHost}`) : host;
}

function McpServer({ data, isAdmin }: { data: McpInfo; isAdmin: boolean }) {
  const update = useSettingsMutation(mcp.update, { invalidates: [mcp.info] });
  const hosts = [
    ...snippetHosts.filter((h) => h in data.snippets),
    ...Object.keys(data.snippets).filter((h) => !snippetHosts.includes(h as never)),
  ];
  const [host, setHost] = useState(hosts[0] ?? "");
  const snippet = data.snippets[host];
  return (
    <div className="flex flex-col gap-4">
      <SettingRow
        title={t("settingsKeys.mcp.enabled")}
        description={t("settingsKeys.mcp.enabledHint")}
        control={
          <Switch
            checked={data.enabled}
            disabled={!isAdmin || update.isPending}
            aria-label={t("settingsKeys.mcp.enabled")}
            onCheckedChange={(enabled) => update.mutate({ enabled })}
          />
        }
      />
      <Alert tone="info" title={t("settingsKeys.mcp.safetyTitle")}>
        {t("settingsKeys.mcp.safety")}{" "}
        <Link to="/approvals" className="font-medium underline">
          {t("settingsKeys.mcp.approvalsLink")}
        </Link>
      </Alert>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink-strong">{t("settingsKeys.mcp.url")}</span>
          <CopyField value={data.url} aria-label={t("settingsKeys.mcp.url")} />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink-strong">{t("settingsKeys.mcp.oauth")}</span>
          <CopyField value={data.oauthMetadataUrl} aria-label={t("settingsKeys.mcp.oauth")} />
        </div>
      </div>
      <p className="m-0 text-[12.5px] text-muted-foreground">
        {t("settingsKeys.mcp.tools", { total: data.tools.total, readOnly: data.tools.readOnly, destructive: data.tools.destructive })}
      </p>
      {hosts.length > 0 && snippet !== undefined && (
        <div className="flex flex-col gap-2">
          <Segmented value={host} onValueChange={setHost} aria-label={t("settingsKeys.mcp.host")} className="self-start">
            {hosts.map((h) => (
              <SegmentedItem key={h} value={h}>
                {hostLabel(h)}
              </SegmentedItem>
            ))}
          </Segmented>
          <CodeBlock code={snippet} tone="dark" maxHeight={260} />
        </div>
      )}
    </div>
  );
}

function McpTokens({ isAdmin }: { isAdmin: boolean }) {
  const [creating, setCreating] = useState(false);
  const [whose, setWhose] = useState<Whose>("mine");
  const [revoked, setRevoked] = useState(false);
  return (
    <SectionCard
      title={t("settingsKeys.mcp.tokensTitle")}
      description={t("settingsKeys.mcp.tokensDescription")}
      flush
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          <IconPlus size={15} stroke={1.8} />
          {t("settingsKeys.mcp.createToken")}
        </Button>
      }
    >
      <KeyFilters isAdmin={isAdmin} whose={whose} setWhose={setWhose} revoked={revoked} setRevoked={setRevoked} />
      <KeyTable kind="mcp" everyone={whose === "everyone"} includeRevoked={revoked} empty={t("settingsKeys.mcp.noTokens")} />
      <KeySheet kind="mcp" open={creating} onOpenChange={setCreating} />
    </SectionCard>
  );
}

type Client = OpOutput<typeof mcp.clients>["clients"][number];

function McpClients() {
  const list = useOp(mcp.clients, {});
  const [revoking, setRevoking] = useState<Client | null>(null);
  const revoke = useSettingsMutation(mcp.revokeClient, {
    invalidates: [mcp.clients, mcp.info],
    success: t("settingsKeys.mcp.clientRevoked"),
  });
  return (
    <SectionCard title={t("settingsKeys.mcp.clientsTitle")} description={t("settingsKeys.mcp.clientsDescription")} flush>
      {list.error ? (
        <OpErrorCallout error={list.error} onRetry={() => void list.refetch()} className="mx-5 mb-5" />
      ) : (
        <DataTable<Client>
          bare
          aria-label={t("settingsKeys.mcp.clientsTitle")}
          loading={list.isPending}
          rows={list.data?.clients ?? []}
          getRowId={(c) => c.id}
          empty={<EmptyState compact icon={<IconPlugConnected />} title={t("settingsKeys.mcp.noClients")} />}
          rowActions={(c) => [{ label: t("settingsKeys.revoke"), destructive: true, onSelect: () => setRevoking(c) }]}
          columns={[
            {
              id: "name",
              header: t("settingsKeys.create.name"),
              cell: (c) => (
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{c.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{c.redirectUris[0] ?? ""}</span>
                </span>
              ),
            },
            { id: "tokens", header: t("settingsKeys.mcp.activeTokens"), cell: (c) => c.activeTokens },
            {
              id: "used",
              header: t("settingsKeys.lastUsed"),
              align: "right",
              cell: (c) => (
                <span className="text-muted-foreground">{c.lastUsedAt ? formatRelative(c.lastUsedAt) : t("settings.never")}</span>
              ),
            },
          ]}
        />
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("settingsKeys.mcp.revokeClientTitle", { name: revoking?.name ?? "" })}
        description={t("settingsKeys.mcp.revokeClientDescription")}
        confirmLabel={t("settingsKeys.revoke")}
        destructive
        onConfirm={() => (revoking ? revoke.mutateAsync({ clientId: revoking.id }).then(() => undefined) : undefined)}
      />
    </SectionCard>
  );
}
