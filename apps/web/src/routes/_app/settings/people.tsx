// Settings > People: everyone with an account (role, status, 2FA, last
// sign-in) and the invites waiting to be accepted. Clicking a person opens
// their sheet with access per project and service.

import { auth, invites, type OpOutput, users } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Avatar } from "@seylo/ui/components/avatar";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { DataTable, timeColumnWidth } from "@seylo/ui/components/data-table";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { IconMailForward, IconSearch, IconUserPlus, IconUsers } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { summarizeActions } from "../../../components/settings/actions";
import { formatDate, formatRelative } from "../../../components/settings/format";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { OpErrorCallout } from "../../../components/settings/op-state";
import { SettingsPage } from "../../../components/settings/page";
import { InviteSheet } from "../../../components/settings/people/invite-sheet";
import { UserSheet } from "../../../components/settings/people/user-sheet";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/people")({
  component: PeoplePage,
});

type User = OpOutput<typeof users.list>["users"][number];
type Invite = OpOutput<typeof invites.list>["invites"][number];

function PeoplePage() {
  const [inviting, setInviting] = useState(false);
  return (
    <SettingsPage
      title={t("settingsPeople.title")}
      subtitle={t("settingsPeople.subtitle")}
      actions={
        <Button variant="primary" onClick={() => setInviting(true)}>
          <IconUserPlus size={16} stroke={1.8} />
          {t("settingsPeople.invite.open")}
        </Button>
      }
    >
      <UsersSection />
      <InvitesSection onInvite={() => setInviting(true)} />
      <InviteSheet open={inviting} onOpenChange={setInviting} />
    </SettingsPage>
  );
}

function UsersSection() {
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  const list = useOp(users.list, query ? { q: query } : {});
  const me = useOp(auth.whoami, {});
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <SectionCard
      title={t("settingsPeople.users.title")}
      flush
      actions={
        <div className="relative w-full sm:w-60">
          <IconSearch size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("settingsPeople.users.search")}
            aria-label={t("settingsPeople.users.search")}
            className="h-8 pl-8 text-[12.5px]"
          />
        </div>
      }
    >
      {list.error ? (
        <div className="px-5 pb-5">
          <OpErrorCallout error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : (
        <DataTable<User>
          bare
          aria-label={t("settingsPeople.users.title")}
          loading={list.isPending}
          rows={list.data?.users ?? []}
          getRowId={(u) => u.id}
          onRowClick={(u) => setOpenId(u.id)}
          // From md up the table scrolls below 560px; a phone hides columns instead, so nothing runs off the card.
          className="md:[&>table]:min-w-[560px]"
          empty={<EmptyState compact icon={<IconUsers />} title={t("settingsPeople.users.empty")} />}
          columns={[
            {
              id: "person",
              header: t("settingsPeople.users.person"),
              skeletonLines: 2,
              sortValue: (u) => u.email,
              cell: (u) => (
                <span className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={u.name || u.email} src={u.avatarUrl} size="sm" decorative />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{u.name || u.email}</span>
                    {u.name && <span className="truncate text-xs text-muted-foreground">{u.email}</span>}
                  </span>
                  {u.id === me.data?.viewer.id && <Chip tone="track">{t("settingsPeople.users.you")}</Chip>}
                </span>
              ),
            },
            {
              id: "role",
              header: t("settingsPeople.invite.role"),
              skeletonWidth: "10%",
              sortValue: (u) => ["owner", "admin", "member"].indexOf(u.role),
              cell: (u) => (
                <span className="flex flex-wrap gap-1">
                  <Chip tone={u.role === "member" ? "gray" : "blue"}>{t(`roles.${u.role}`)}</Chip>
                  {/* A phone has no Status column: only a disabled account says so, here. */}
                  {u.status !== "active" && (
                    <Chip tone="red" className="md:hidden">
                      {t(`settingsPeople.status.${u.status}`)}
                    </Chip>
                  )}
                </span>
              ),
            },
            {
              id: "access",
              header: t("settingsPeople.users.access"),
              hideOnMobile: true,
              skeletonWidth: "19.3%",
              cell: (u) =>
                u.role === "member" ? (
                  <span className="text-muted-foreground">{t("settingsPeople.users.grants", { count: u.grantCount })}</span>
                ) : (
                  <span className="text-muted-foreground">{t("settingsActions.all")}</span>
                ),
            },
            {
              id: "security",
              header: t("settingsPeople.users.security"),
              hideOnMobile: true,
              skeletonWidth: "17.3%",
              cell: (u) => (
                <span className="flex gap-1">
                  {u.twoFactor ? (
                    <Chip tone="green">{t("settingsPeople.users.twoFactor")}</Chip>
                  ) : (
                    <Chip tone="gray">{t("settingsPeople.users.noTwoFactor")}</Chip>
                  )}
                  {u.passkeyCount > 0 && <Chip tone="green">{t("settingsPeople.users.passkeys", { count: u.passkeyCount })}</Chip>}
                </span>
              ),
            },
            {
              id: "last",
              header: t("settingsPeople.users.lastLogin"),
              hideOnMobile: true,
              width: timeColumnWidth,
              sortValue: (u) => u.lastLoginAt ?? "",
              cell: (u) => (
                <span className="text-muted-foreground">{u.lastLoginAt ? formatRelative(u.lastLoginAt) : t("settings.never")}</span>
              ),
            },
            {
              id: "status",
              header: t("settingsPeople.users.status"),
              align: "right",
              hideOnMobile: true,
              skeletonWidth: "11.4%",
              cell: (u) => <Chip tone={u.status === "active" ? "green" : "red"}>{t(`settingsPeople.status.${u.status}`)}</Chip>,
            },
          ]}
        />
      )}
      {me.data && (
        <UserSheet
          userId={openId}
          viewer={{ id: me.data.viewer.id, role: me.data.viewer.role }}
          onOpenChange={(open) => !open && setOpenId(null)}
        />
      )}
    </SectionCard>
  );
}

const inviteTones = { pending: "amber", accepted: "green", expired: "gray", revoked: "red" } as const;
type InviteFilter = "pending" | "all";

function InvitesSection({ onInvite }: { onInvite: () => void }) {
  const [filter, setFilter] = useState<InviteFilter>("pending");
  const list = useOp(invites.list, filter === "pending" ? { status: "pending" } : {});
  const revoke = useSettingsMutation(invites.revoke, { invalidates: [invites.list], success: t("settingsPeople.invites.revoked") });

  return (
    <SectionCard
      title={t("settingsPeople.invites.title")}
      description={t("settingsPeople.invites.description")}
      flush
      actions={
        <Segmented value={filter} onValueChange={(v) => setFilter(v as InviteFilter)} aria-label={t("settingsPeople.invites.filter")}>
          <SegmentedItem value="pending">{t("settingsPeople.invites.pending")}</SegmentedItem>
          <SegmentedItem value="all">{t("settingsPeople.invites.all")}</SegmentedItem>
        </Segmented>
      }
    >
      {list.error ? (
        <div className="px-5 pb-5">
          <OpErrorCallout error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : (
        <DataTable<Invite>
          bare
          aria-label={t("settingsPeople.invites.title")}
          loading={list.isPending}
          rows={list.data?.invites ?? []}
          getRowId={(i) => i.id}
          className="md:[&>table]:min-w-[560px]"
          empty={
            <EmptyState
              compact
              icon={<IconMailForward />}
              title={t("settingsPeople.invites.empty")}
              action={
                <Button size="sm" onClick={onInvite}>
                  {t("settingsPeople.invite.open")}
                </Button>
              }
            />
          }
          rowActions={(i) =>
            i.status === "pending"
              ? [{ label: t("settingsPeople.invites.revoke"), destructive: true, onSelect: () => revoke.mutate({ inviteId: i.id }) }]
              : []
          }
          columns={[
            {
              id: "email",
              header: t("settingsPeople.invite.email"),
              sortValue: (i) => i.email,
              cell: (i) => <span className="font-medium">{i.email}</span>,
            },
            {
              id: "role",
              header: t("settingsPeople.invite.role"),
              skeletonWidth: "13%",
              cell: (i) => <Chip tone={i.role === "admin" ? "blue" : "gray"}>{t(`roles.${i.role}`)}</Chip>,
            },
            {
              id: "access",
              header: t("settingsPeople.users.access"),
              hideOnMobile: true,
              skeletonWidth: "23%",
              cell: (i) =>
                i.role === "admin" ? (
                  <span className="text-muted-foreground">{t("settingsActions.all")}</span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {i.grants.length === 0 && <span className="text-muted-foreground">-</span>}
                    {i.grants.map((g) => (
                      <Chip
                        key={`${g.scopeType}:${g.scopeId}`}
                        tone={g.scopeType === "project" ? "blue" : "violet"}
                        title={summarizeActions(g.actions)}
                      >
                        {g.scopeName || t("settingsPeople.grants.deleted")}
                      </Chip>
                    ))}
                  </span>
                ),
            },
            {
              id: "by",
              header: t("settingsPeople.invites.invitedBy"),
              hideOnMobile: true,
              skeletonWidth: "11.5%",
              cell: (i) => <span className="text-muted-foreground">{i.invitedBy ? i.invitedBy.name || i.invitedBy.email : "-"}</span>,
            },
            {
              id: "expires",
              header: t("settingsPeople.invites.expires"),
              hideOnMobile: true,
              skeletonWidth: "12%",
              sortValue: (i) => i.expiresAt,
              cell: (i) => (
                <span className="text-muted-foreground">
                  {i.status === "accepted" && i.acceptedAt ? formatDate(i.acceptedAt) : formatRelative(i.expiresAt)}
                </span>
              ),
            },
            {
              id: "status",
              header: t("settingsPeople.users.status"),
              align: "right",
              skeletonWidth: "12.5%",
              cell: (i) => <Chip tone={inviteTones[i.status]}>{t(`settingsPeople.invites.statuses.${i.status}`)}</Chip>,
            },
          ]}
        />
      )}
    </SectionCard>
  );
}
