// Your account > Push notifications (0.2.7): turn push on for this device,
// the devices that get your pushes, which alerts reach them, and installing
// the panel as an app. Works only while an admin has the app and push
// notifications on, and only on the panel domain over HTTPS: anywhere else
// the page says where to open it. lib/pwa.ts does the browser's part.

import { type alerts, OpError, push } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { IconBell, IconBellOff, IconDeviceMobile, IconExternalLink, IconLoader2 } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { formatRelative } from "../../../components/settings/format";
import { invalidateOps, useSettingsMutation } from "../../../components/settings/mutation";
import { QueryView, toastError } from "../../../components/settings/op-state";
import { SettingRow, SettingsPage } from "../../../components/settings/page";
import { SettingRowSkeleton } from "../../../components/settings/skeletons";
import { type MessageKey, t } from "../../../i18n/t";
import { prefetchOp } from "../../../lib/prefetch";
import {
  canPromptInstall,
  canPush,
  currentSubscription,
  endpointHashOf,
  onDomain,
  onInstallChange,
  PushDenied,
  promptInstall,
  pushSupport,
  subscribeThisBrowser,
  unsubscribeThisBrowser,
} from "../../../lib/pwa";

export const Route = createFileRoute("/_app/settings/push")({
  loader: ({ context }) => prefetchOp(context, push.mine, {}),
  component: PushPage,
});

function PushPage() {
  const mine = useOp(push.mine, {});
  return (
    <SettingsPage title={t("settingsPush.title")} subtitle={t("settingsPush.subtitle")}>
      <QueryView query={mine} skeleton={<SettingRowSkeleton titleWidth="w-40" />}>
        {(data) => <PushSettings data={data} />}
      </QueryView>
    </SettingsPage>
  );
}

function PushSettings({ data }: { data: push.MyPush }) {
  const here = onDomain(data.domainUrl);
  return (
    <>
      {!data.available && (
        <Alert tone="neutral" title={t("settingsPush.unavailableTitle")}>
          {data.reason}
        </Alert>
      )}
      {data.available && !here && data.domainUrl && (
        <Alert
          tone="info"
          action={
            <Button variant="secondary" size="sm" asChild>
              <a href={`${data.domainUrl}/settings/push`}>
                {t("settingsPush.openButton", { host: new URL(data.domainUrl).host })}
                <IconExternalLink size={14} aria-hidden="true" />
              </a>
            </Button>
          }
        >
          {t("settingsPush.openOnDomain", { url: data.domainUrl })}
        </Alert>
      )}
      {data.available && here && <ThisDevice data={data} />}
      {data.available && here && <Install />}
      {data.enabled && <Devices data={data} />}
      {data.enabled && <Events data={data} />}
    </>
  );
}

/** Whether this browser is one of the person's devices: null while it checks. */
function useThisDeviceId(devices: push.PushDevice[]): string | null | undefined {
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void (async () => {
      const subscription = await currentSubscription().catch(() => null);
      const hash = subscription ? await endpointHashOf(subscription.endpoint) : null;
      if (live) setId(devices.find((device) => device.endpointHash === hash)?.id ?? null);
    })();
    return () => {
      live = false;
    };
  }, [devices]);
  return id;
}

function ThisDevice({ data }: { data: push.MyPush }) {
  const support = pushSupport();
  const deviceId = useThisDeviceId(data.devices);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(() => "Notification" in window && Notification.permission === "denied");
  // Allowed again in the site settings: the page notices without a reload.
  useEffect(() => {
    const recheck = () => setDenied("Notification" in window && Notification.permission === "denied");
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    let status: PermissionStatus | null = null;
    void navigator.permissions
      ?.query({ name: "notifications" })
      .then((result) => {
        status = result;
        result.addEventListener("change", recheck);
      })
      .catch(() => {});
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
      status?.removeEventListener("change", recheck);
    };
  }, []);
  const subscribe = useSettingsMutation(push.subscribe, { failure: false });
  const remove = useSettingsMutation(push.removeDevice, { failure: false });
  const test = useSettingsMutation(push.test, {
    onSuccess: (output) => {
      const failed = output.results.filter((result) => !result.ok);
      for (const result of failed) toast.error(t("settingsPush.test.failed", { label: result.label, error: result.error ?? "" }));
      const ok = output.results.length - failed.length;
      if (ok > 0) toast.success(t("settingsPush.test.sent", { count: ok }));
      if (output.results.length === 0) toast.info(t("settingsPush.test.none"));
      void invalidateOps([push.mine]);
    },
  });

  if (!canPush(support)) {
    return (
      <SectionCard title={t("settingsPush.thisDevice.title")}>
        <Alert tone="neutral">
          {support.ios && !support.standalone ? t("settingsPush.thisDevice.ios") : t("settingsPush.thisDevice.unsupported")}
        </Alert>
      </SectionCard>
    );
  }

  async function turnOn() {
    if (!data.publicKey) {
      toast.error(t("settingsPush.thisDevice.failed", { error: t("settingsPush.thisDevice.noKey") }));
      return;
    }
    setBusy(true);
    try {
      const input = await subscribeThisBrowser(data.publicKey);
      await subscribe.mutateAsync(input);
      await invalidateOps([push.mine]);
      toast.success(t("settingsPush.thisDevice.turnedOn"));
    } catch (error) {
      if (error instanceof PushDenied) {
        const blocked = error.message === "denied";
        setDenied(blocked);
        toast.info(blocked ? t("settingsPush.thisDevice.denied") : t("settingsPush.thisDevice.dismissed"));
      } else if (error instanceof OpError) {
        // The panel refused the subscription: drop it here too.
        toastError(error);
        await unsubscribeThisBrowser().catch(() => {});
      } else {
        toast.error(t("settingsPush.thisDevice.failed", { error: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (!deviceId) return;
    setBusy(true);
    try {
      await remove.mutateAsync({ deviceId });
      await unsubscribeThisBrowser().catch(() => {});
      await invalidateOps([push.mine]);
      toast.success(t("settingsPush.thisDevice.turnedOff"));
    } catch (error) {
      toastError(error as never);
    } finally {
      setBusy(false);
    }
  }

  const on = typeof deviceId === "string";
  return (
    <SectionCard title={t("settingsPush.thisDevice.title")}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            {on ? <IconBell size={18} aria-hidden="true" /> : <IconBellOff size={18} aria-hidden="true" />}
          </span>
          <span className="min-w-0 flex-1 text-[13.5px]">{on ? t("settingsPush.thisDevice.on") : t("settingsPush.thisDevice.off")}</span>
          <div className="flex flex-wrap gap-2">
            {deviceId === undefined ? (
              <IconLoader2 size={18} className="animate-spin text-muted-foreground" aria-hidden="true" />
            ) : on ? (
              <Button variant="secondary" disabled={busy} onClick={() => void turnOff()}>
                {t("settingsPush.thisDevice.turnOff")}
              </Button>
            ) : (
              <Button variant="primary" disabled={busy || denied} onClick={() => void turnOn()}>
                {t("settingsPush.thisDevice.turnOn")}
              </Button>
            )}
            {data.devices.length > 0 && (
              <Button variant="ghost" disabled={test.isPending} onClick={() => test.mutate({})}>
                {t("settingsPush.test.button")}
              </Button>
            )}
          </div>
        </div>
        {denied && !on && <Alert tone="warning">{t("settingsPush.thisDevice.denied")}</Alert>}
      </div>
    </SectionCard>
  );
}

function Install() {
  const support = pushSupport();
  const [, rerender] = useState(0);
  useEffect(() => onInstallChange(() => rerender((n) => n + 1)), []);
  const [installed, setInstalled] = useState(false);
  let body: React.ReactNode;
  if (support.standalone) body = <span className="text-[13.5px]">{t("settingsPush.install.installed")}</span>;
  else if (installed) body = <span className="text-[13.5px]">{t("settingsPush.install.installedNow")}</span>;
  else if (canPromptInstall())
    body = (
      <Button variant="secondary" onClick={() => void promptInstall().then((done) => setInstalled(done))}>
        <IconDeviceMobile size={15} aria-hidden="true" />
        {t("settingsPush.install.button")}
      </Button>
    );
  else
    body = (
      <span className="text-[13.5px] text-muted-foreground">
        {support.ios ? t("settingsPush.install.ios") : t("settingsPush.install.other")}
      </span>
    );
  return (
    <SectionCard title={t("settingsPush.install.title")} description={t("settingsPush.install.description")}>
      {body}
    </SectionCard>
  );
}

function Devices({ data }: { data: push.MyPush }) {
  const here = useThisDeviceId(data.devices);
  const remove = useSettingsMutation(push.removeDevice, { invalidates: [push.mine], success: t("settingsPush.devices.removed") });
  return (
    <SectionCard title={t("settingsPush.devices.title")} description={t("settingsPush.devices.description")}>
      {data.devices.length === 0 ? (
        <p className="m-0 text-[13.5px] text-muted-foreground">{t("settingsPush.devices.empty")}</p>
      ) : (
        <ul aria-label={t("settingsPush.devices.title")} className="m-0 flex list-none flex-col p-0">
          {data.devices.map((device) => (
            <li
              key={device.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-divider py-3 first:border-t-0 first:pt-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">
                  {device.label}
                  {device.id === here && <Chip tone="blue">{t("settingsPush.devices.here")}</Chip>}
                  {device.failing && <Chip tone="amber">{t("settingsPush.devices.failing")}</Chip>}
                </span>
                <span className="text-[12.5px] text-muted-foreground">
                  {t("settingsPush.devices.meta", {
                    added: formatRelative(device.createdAt),
                    last: device.lastSentAt ? formatRelative(device.lastSentAt) : t("settingsPush.devices.never"),
                  })}
                </span>
                {device.failing && device.lastError && <span className="text-[12.5px] text-muted-foreground">{device.lastError}</span>}
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(
                    { deviceId: device.id },
                    { onSuccess: () => (device.id === here ? void unsubscribeThisBrowser().catch(() => {}) : undefined) },
                  )
                }
              >
                {t("settingsPush.devices.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/** An event's name and hint: the alert rules' wording, plus node_online, which only push offers. */
function eventText(event: push.PushEventName): { name: string; hint: string } {
  if (event === "node_online") return { name: t("settingsPush.events.nodeOnline.name"), hint: t("settingsPush.events.nodeOnline.hint") };
  const key = event as alerts.AlertRuleEventName;
  return {
    name: t(`settingsNotifications.events.${key}.name` as MessageKey),
    hint: t(`settingsNotifications.events.${key}.hint` as MessageKey),
  };
}

function Events({ data }: { data: push.MyPush }) {
  const save = useSettingsMutation(push.setEvents, { invalidates: [push.mine], success: t("settingsPush.events.saved") });
  // While a save runs, its choice; otherwise what the panel has (a failed save shows the truth again).
  const chosen = new Set(save.isPending && save.variables ? save.variables.events : data.events);
  return (
    <SectionCard title={t("settingsPush.events.title")} description={t("settingsPush.events.description")}>
      <div className="flex flex-col">
        {data.eventChoices.map((event) => {
          const { name, hint } = eventText(event);
          return (
            <SettingRow
              key={event}
              title={name}
              description={hint}
              control={
                <Switch
                  checked={chosen.has(event)}
                  disabled={save.isPending}
                  aria-label={name}
                  onCheckedChange={(on) => {
                    const next = new Set(chosen);
                    if (on) next.add(event);
                    else next.delete(event);
                    save.mutate({ events: data.eventChoices.filter((choice) => next.has(choice)) });
                  }}
                />
              }
            />
          );
        })}
      </div>
    </SectionCard>
  );
}
