// Settings > Notifications (Notifications board): the switch for the
// installable app and push notifications (admins, 0.2.7), channels defined
// once as cards, the add/edit channel card with a test send, and the
// default alert rules every service uses unless it sets its own.

import { auth, notifications } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Chip } from "@seylo/ui/components/chip";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { ButtonSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconBell } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { formatDuration, formatRelative } from "../../../components/settings/format";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { AppPushCard } from "../../../components/settings/notifications/app-push-card";
import { ChannelForm } from "../../../components/settings/notifications/channel-form";
import { DefaultAlerts } from "../../../components/settings/notifications/default-alerts";
import { OpErrorCallout } from "../../../components/settings/op-state";
import { SettingsPage } from "../../../components/settings/page";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/notifications")({
  component: NotificationsPage,
});

type Channel = notifications.Channel;

const channelGrid = "grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-4";

const kindTones = {
  smtp: "blue",
  webhook: "gray",
  discord: "violet",
  slack: "green",
  telegram: "sky",
  ntfy: "amber",
  pushover: "sky",
  gotify: "gray",
} as const;

function NotificationsPage() {
  const list = useOp(notifications.channels, {});
  const me = useOp(auth.whoami, {});
  const canEdit = me.data?.viewer.role === "owner" || me.data?.viewer.role === "admin";
  const [editing, setEditing] = useState<Channel | null>(null);
  const [formKey, setFormKey] = useState(0);
  const channels = list.data?.channels ?? [];

  function edit(channel: Channel | null) {
    setEditing(channel);
    setFormKey((k) => k + 1);
    if (channel) document.getElementById("channel-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <SettingsPage title={t("settingsNotifications.title")} subtitle={t("settingsNotifications.subtitle")}>
      {canEdit && <AppPushCard />}
      {list.error ? (
        <OpErrorCallout error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <section aria-label={t("settingsNotifications.channels")} className={channelGrid}>
          {list.isPending && (
            <LoadingRegion label={t("common.loading")} className={cn("col-span-full", channelGrid)}>
              <ChannelCardSkeleton canEdit={canEdit} />
              <ChannelCardSkeleton canEdit={canEdit} />
            </LoadingRegion>
          )}
          {!list.isPending && channels.length === 0 && (
            <Card className="col-span-full">
              <EmptyState
                compact
                icon={<IconBell />}
                title={t("settingsNotifications.empty")}
                description={t("settingsNotifications.emptyHint")}
              />
            </Card>
          )}
          {channels.map((channel) => (
            <ChannelCard key={channel.id} channel={channel} canEdit={canEdit} onEdit={() => edit(channel)} />
          ))}
        </section>
      )}

      <div id="channel-form" className="flex scroll-mt-6 flex-wrap items-start gap-4">
        {canEdit && <ChannelForm key={formKey} editing={editing} onDone={() => edit(null)} />}
        <DefaultAlerts channels={channels} canEdit={canEdit} />
      </div>
    </SettingsPage>
  );
}

/** A channel card while the list loads: the kind chip and name, the two buttons for editors, the target and the usage line. */
function ChannelCardSkeleton({ canEdit }: { canEdit: boolean }) {
  return (
    <Card aria-hidden="true" className="min-w-0 gap-[9px] px-[18px] py-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Skeleton className="h-[22px] w-16 rounded-chip" />
        <SkeletonText className="w-28 text-sm" />
        {canEdit && (
          <span className="ml-auto flex gap-1.5">
            <ButtonSkeleton size="sm" className="h-[30px] w-[78px]" />
            <ButtonSkeleton size="sm" className="h-[30px] w-11" />
          </span>
        )}
      </div>
      <SkeletonText className="w-40 font-mono text-xs" />
      <SkeletonText className="w-32 text-xs" />
    </Card>
  );
}

function ChannelCard({ channel, canEdit, onEdit }: { channel: Channel; canEdit: boolean; onEdit: () => void }) {
  const test = useSettingsMutation(notifications.testChannel, {
    invalidates: [notifications.channels],
    failure: t("settingsNotifications.testFailed"),
    onSuccess: (out) =>
      out.ok
        ? toast.success(t("settingsNotifications.testSent"), { description: formatDuration(out.durationMs) })
        : toast.error(t("settingsNotifications.testFailed"), { description: out.error ?? "" }),
  });
  const used = channel.usedBy.services;
  return (
    <Card className="min-w-0 gap-[9px] px-[18px] py-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Chip tone={kindTones[channel.kind]}>{t(`settingsNotifications.kinds.${channel.kind}`)}</Chip>
        <b className="min-w-0 truncate text-sm font-semibold">{channel.name}</b>
        {channel.isDefault && <Chip tone="gray">{t("settingsNotifications.default")}</Chip>}
        {!channel.enabled && <Chip tone="amber">{t("settingsNotifications.off")}</Chip>}
        {canEdit && (
          <span className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              className="h-[30px] bg-muted shadow-none"
              disabled={test.isPending}
              onClick={() => test.mutate({ channelId: channel.id })}
            >
              {test.isPending ? t("settingsNotifications.sending") : t("settingsNotifications.sendTest")}
            </Button>
            <Button size="sm" className="h-[30px] bg-muted shadow-none" onClick={onEdit}>
              {t("settings.edit")}
            </Button>
          </span>
        )}
      </div>
      <span className="truncate font-mono text-xs text-ink-strong" title={channel.target}>
        {channel.target}
      </span>
      <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>
          {used > 0
            ? t("settingsNotifications.usedBy", { count: used })
            : channel.usedBy.defaults
              ? t("settingsNotifications.usedByDefaults")
              : t("settingsNotifications.unused")}
        </span>
        {channel.lastDelivery && (
          <span
            className={channel.lastDelivery.status === "failed" ? "text-chip-red-fg" : undefined}
            title={channel.lastDelivery.error ?? undefined}
          >
            {t(`settingsNotifications.lastDelivery.${channel.lastDelivery.status}`, { when: formatRelative(channel.lastDelivery.at) })}
          </span>
        )}
      </span>
    </Card>
  );
}
