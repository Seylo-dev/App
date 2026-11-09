// Where you are signed in: each browser session with its address and last
// activity; sign one out, or every other one.

import { auth, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { DataTable } from "@seylo/ui/components/data-table";
import { SectionCard } from "@seylo/ui/components/section-card";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { describeUserAgent, formatDateTime, formatRelative } from "../format";
import { useSettingsMutation } from "../mutation";
import { OpErrorCallout } from "../op-state";

type Session = OpOutput<typeof auth.listSessions>["sessions"][number];

export function SessionsSection() {
  const list = useOp(auth.listSessions, {});
  const [confirmAll, setConfirmAll] = useState(false);
  const revoke = useSettingsMutation(auth.revokeSession, {
    invalidates: [auth.listSessions],
    success: t("settingsSecurity.sessions.signedOut"),
  });
  const revokeOthers = useSettingsMutation(auth.revokeOtherSessions, {
    invalidates: [auth.listSessions],
    success: (out) => t("settingsSecurity.sessions.othersSignedOut", { count: out.revoked }),
  });
  const others = (list.data?.sessions ?? []).filter((s) => !s.current).length;

  return (
    <SectionCard
      title={t("settingsSecurity.sessions.title")}
      description={t("settingsSecurity.sessions.description")}
      flush
      actions={
        others > 0 && (
          <Button size="sm" onClick={() => setConfirmAll(true)}>
            {t("settingsSecurity.sessions.signOutOthers")}
          </Button>
        )
      }
    >
      {list.error ? (
        <OpErrorCallout error={list.error} onRetry={() => void list.refetch()} className="mx-5 mb-5" />
      ) : (
        <DataTable<Session>
          bare
          aria-label={t("settingsSecurity.sessions.title")}
          loading={list.isPending}
          rows={list.data?.sessions ?? []}
          getRowId={(s) => s.id}
          // From md up the table scrolls below 520px; a phone hides columns instead, so nothing runs off the card.
          className="md:[&>table]:min-w-[520px]"
          rowActions={(s) =>
            s.current
              ? []
              : [{ label: t("settingsSecurity.sessions.signOut"), destructive: true, onSelect: () => revoke.mutate({ sessionId: s.id }) }]
          }
          columns={[
            {
              id: "device",
              header: t("settingsSecurity.sessions.device"),
              cell: (s) => (
                <span className="flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{describeUserAgent(s.userAgent) ?? t("settingsSecurity.sessions.unknownDevice")}</span>
                    {s.current && <Chip tone="green">{t("settingsSecurity.sessions.current")}</Chip>}
                  </span>
                  {/* A phone has no Address column: the address goes under the browser. */}
                  {s.ip && <span className="font-mono text-xs text-muted-foreground md:hidden">{s.ip}</span>}
                </span>
              ),
            },
            {
              id: "ip",
              header: t("settingsSecurity.sessions.ip"),
              hideOnMobile: true,
              skeletonWidth: "18%",
              cell: (s) => <span className="font-mono text-[12.5px]">{s.ip ?? "-"}</span>,
            },
            {
              id: "started",
              header: t("settingsSecurity.sessions.started"),
              skeletonWidth: "25%",
              cell: (s) => formatDateTime(s.createdAt),
              hideOnMobile: true,
            },
            {
              id: "seen",
              header: t("settingsSecurity.sessions.lastActive"),
              align: "right",
              skeletonWidth: "15%",
              sortValue: (s) => s.lastSeenAt,
              cell: (s) => <span className="whitespace-nowrap text-muted-foreground">{formatRelative(s.lastSeenAt)}</span>,
            },
          ]}
        />
      )}
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title={t("settingsSecurity.sessions.confirmTitle")}
        description={t("settingsSecurity.sessions.confirmDescription", { count: others })}
        confirmLabel={t("settingsSecurity.sessions.signOutOthers")}
        destructive
        onConfirm={() => revokeOthers.mutateAsync({}).then(() => undefined)}
      />
    </SectionCard>
  );
}
