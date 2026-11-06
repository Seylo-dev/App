// The list of API keys or MCP tokens: what each may do, where, when it was
// last used and when it expires, with revoke in the row menu. Owners and
// admins can switch to everyone's keys.

import { apiKeys, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { DataTable } from "@seylo/ui/components/data-table";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { IconKey } from "@tabler/icons-react";
import type * as React from "react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { summarizeActions } from "../actions";
import { formatDate, formatRelative } from "../format";
import { useSettingsMutation } from "../mutation";
import { OpErrorCallout } from "../op-state";

type Key = OpOutput<typeof apiKeys.list>["keys"][number];

/**
 * What the columns get with typical keys, for the loading rows (the scope
 * column takes the rest). MCP tokens carry the client's name, so their
 * name column is wider.
 */
const skeletonWidths = {
  api: { name: "19.5%", used: "16%", expires: "14%" },
  mcp: { name: "34%", used: "14.5%", expires: "12%" },
} as const;

export function KeyTable({
  kind,
  everyone,
  includeRevoked,
  empty,
}: {
  kind: "api" | "mcp";
  everyone: boolean;
  includeRevoked: boolean;
  empty: React.ReactNode;
}) {
  const list = useOp(apiKeys.list, { kind, all: everyone, includeRevoked });
  const [revoking, setRevoking] = useState<Key | null>(null);
  const revoke = useSettingsMutation(apiKeys.revoke, { invalidates: [apiKeys.list], success: t("settingsKeys.revoked") });

  if (list.error) return <OpErrorCallout error={list.error} onRetry={() => void list.refetch()} className="mx-5 mb-5" />;

  return (
    <>
      <DataTable<Key>
        bare
        aria-label={t(`settingsKeys.tableLabel.${kind}`)}
        loading={list.isPending}
        rows={list.data?.keys ?? []}
        getRowId={(key) => key.id}
        minWidth={600}
        empty={<EmptyState compact icon={<IconKey />} title={empty} />}
        rowActions={(key) =>
          key.revokedAt ? [] : [{ label: t("settingsKeys.revoke"), destructive: true, onSelect: () => setRevoking(key) }]
        }
        columns={[
          {
            id: "name",
            header: t("settingsKeys.create.name"),
            skeletonWidth: skeletonWidths[kind].name,
            skeletonLines: 2,
            sortValue: (key) => key.name,
            cell: (key) => (
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{key.name}</span>
                  {key.revokedAt && <Chip tone="red">{t("settingsKeys.revokedChip")}</Chip>}
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {key.prefix}…{everyone ? ` · ${key.owner.email}` : ""}
                  {key.mcpClient ? ` · ${key.mcpClient}` : ""}
                </span>
              </span>
            ),
          },
          {
            id: "scope",
            header: t("settingsKeys.scope"),
            cell: (key) => (
              <span className="flex flex-wrap gap-1">
                <Chip tone={key.readOnly ? "green" : "amber"}>
                  {key.readOnly ? t("settingsKeys.readOnly") : t("settingsKeys.readWrite")}
                </Chip>
                <Chip tone="gray">{summarizeActions(key.actions)}</Chip>
                <Chip tone="gray">
                  {key.projectIds === null
                    ? t("settingsKeys.create.allProjects")
                    : t("settingsKeys.projects", { count: key.projectIds.length })}
                </Chip>
              </span>
            ),
          },
          {
            id: "used",
            header: t("settingsKeys.lastUsed"),
            hideOnMobile: true,
            skeletonWidth: skeletonWidths[kind].used,
            sortValue: (key) => key.lastUsedAt ?? "",
            cell: (key) => (
              <span className="text-muted-foreground">{key.lastUsedAt ? formatRelative(key.lastUsedAt) : t("settings.never")}</span>
            ),
          },
          {
            id: "expires",
            header: t("settingsKeys.expires"),
            hideOnMobile: true,
            skeletonWidth: skeletonWidths[kind].expires,
            align: "right",
            sortValue: (key) => key.expiresAt ?? "9999",
            cell: (key) => (
              <span className="text-muted-foreground">
                {key.revokedAt ? formatDate(key.revokedAt) : key.expiresAt ? formatRelative(key.expiresAt) : t("settingsKeys.create.never")}
              </span>
            ),
          },
        ]}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("settingsKeys.revokeTitle", { name: revoking?.name ?? "" })}
        description={t("settingsKeys.revokeDescription")}
        confirmLabel={t("settingsKeys.revoke")}
        destructive
        onConfirm={() => (revoking ? revoke.mutateAsync({ keyId: revoking.id }).then(() => undefined) : undefined)}
      />
    </>
  );
}
