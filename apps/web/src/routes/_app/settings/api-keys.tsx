// Settings > API keys and MCP: scoped API keys for scripts and CI, and the
// MCP server for model hosts (its URL, its two safety switches, one-click
// installs and config snippets per AI tool, tokens and the OAuth clients
// that connected). MCP is read-only by default and anything that deletes
// something waits for a person in Approvals, until an admin turns either
// switch off.

import { auth, mcp, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { CopyField } from "@seylo/ui/components/copy-field";
import { DataTable } from "@seylo/ui/components/data-table";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { IconPlugConnected, IconPlus } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { formatRelative } from "../../../components/settings/format";
import { KeySheet } from "../../../components/settings/keys/key-sheet";
import { KeyTable } from "../../../components/settings/keys/key-table";
import { McpHostSetup, type McpInfo, McpSafetyNote } from "../../../components/settings/keys/mcp-setup";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { OpErrorCallout, QueryView } from "../../../components/settings/op-state";
import { SettingRow, SettingsPage } from "../../../components/settings/page";
import { SettingRowSkeleton } from "../../../components/settings/skeletons";
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

function McpSection({ isAdmin }: { isAdmin: boolean }) {
  const info = useOp(mcp.info, {});
  return (
    <>
      <SectionCard title={t("settingsKeys.mcp.title")} description={t("settingsKeys.mcp.description")}>
        <QueryView query={info} skeleton={<McpSkeleton />} className="flex flex-col gap-4">
          {(data) => <McpServer data={data} isAdmin={isAdmin} />}
        </QueryView>
      </SectionCard>
      <McpTokens isAdmin={isAdmin} askBeforeDestructive={info.data?.askBeforeDestructive ?? true} />
      {isAdmin && <McpClients />}
    </>
  );
}

/** The MCP card's three switches, safety note, the two addresses and the setup snippet while the info loads. */
function McpSkeleton() {
  return (
    <>
      <div className="flex flex-col">
        <SettingRowSkeleton titleWidth="w-24" />
        <SettingRowSkeleton titleWidth="w-48" />
        <SettingRowSkeleton titleWidth="w-44" />
      </div>
      <Skeleton className="h-[67px] bg-chip-blue-bg" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="flex min-w-0 flex-col gap-1.5">
            <SkeletonText className="w-20 text-[12.5px]" />
            <Skeleton className="h-[38px]" />
          </div>
        ))}
      </div>
      <SkeletonText className="w-72 text-[12.5px]" />
      <div className="flex flex-col gap-2">
        {/* Seven AI tools; the track scrolls on a phone. */}
        <Skeleton className="h-8 w-[540px] max-w-full" />
        <SkeletonText className="w-96 max-w-full text-[12.5px]" />
        {/* The setup snippet: one 12.5px line at 1.7 beside the floating Copy button, 12px above and below. */}
        <Skeleton className="h-[49px] bg-terminal" />
      </div>
    </>
  );
}

type McpSwitch = "enabled" | "askBeforeDestructive" | "readOnlyByDefault";

/** The card's switches, in order: the server itself, then the two safety defaults (both on until an admin turns them off). */
const switchCopy = {
  enabled: { title: "settingsKeys.mcp.enabled", hint: "settingsKeys.mcp.enabledHint" },
  askBeforeDestructive: { title: "settingsKeys.mcp.askBeforeDestructive", hint: "settingsKeys.mcp.askBeforeDestructiveHint" },
  readOnlyByDefault: { title: "settingsKeys.mcp.readOnlyByDefault", hint: "settingsKeys.mcp.readOnlyByDefaultHint" },
} as const;

function McpServer({ data, isAdmin }: { data: McpInfo; isAdmin: boolean }) {
  const update = useSettingsMutation(mcp.update, { invalidates: [mcp.info] });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col">
        {(Object.keys(switchCopy) as McpSwitch[]).map((field) => (
          <SettingRow
            key={field}
            title={t(switchCopy[field].title)}
            description={t(switchCopy[field].hint)}
            control={
              <Switch
                checked={data[field]}
                disabled={!isAdmin || update.isPending}
                aria-label={t(switchCopy[field].title)}
                onCheckedChange={(on) => update.mutate({ [field]: on })}
              />
            }
          />
        ))}
      </div>
      <McpSafetyNote info={data} />
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
      <McpHostSetup info={data} />
    </div>
  );
}

function McpTokens({ isAdmin, askBeforeDestructive }: { isAdmin: boolean; askBeforeDestructive: boolean }) {
  const [creating, setCreating] = useState(false);
  const [whose, setWhose] = useState<Whose>("mine");
  const [revoked, setRevoked] = useState(false);
  return (
    <SectionCard
      title={t("settingsKeys.mcp.tokensTitle")}
      description={t("settingsKeys.mcp.tokensDescription")}
      flush
      actions={
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          <IconPlus size={15} stroke={1.8} />
          {t("settingsKeys.mcp.createToken")}
        </Button>
      }
    >
      <KeyFilters isAdmin={isAdmin} whose={whose} setWhose={setWhose} revoked={revoked} setRevoked={setRevoked} />
      <KeyTable kind="mcp" everyone={whose === "everyone"} includeRevoked={revoked} empty={t("settingsKeys.mcp.noTokens")} />
      <KeySheet kind="mcp" open={creating} onOpenChange={setCreating} askBeforeDestructive={askBeforeDestructive} />
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
              skeletonLines: 2,
              cell: (c) => (
                // On a phone the address is cut short, so the last-used time and the menu stay on the card.
                <span className="flex min-w-0 flex-col max-md:max-w-[170px]">
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{c.redirectUris[0] ?? ""}</span>
                  {/* On a phone the Active tokens column is hidden: the count as a line here. */}
                  <span className="text-xs text-muted-foreground md:hidden">
                    {t("settingsKeys.mcp.activeTokensCount", { count: c.activeTokens })}
                  </span>
                </span>
              ),
            },
            {
              id: "tokens",
              header: t("settingsKeys.mcp.activeTokens"),
              hideOnMobile: true,
              skeletonWidth: "17%",
              cell: (c) => c.activeTokens,
            },
            {
              id: "used",
              header: t("settingsKeys.lastUsed"),
              align: "right",
              skeletonWidth: "16%",
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
