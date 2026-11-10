// The admin switch for the installable app and push notifications (0.2.7),
// at the top of Settings > Notifications: what it is for, the switch, and
// why it cannot be turned on yet. The panel refuses turning it on unless the
// page is open on the panel domain over HTTPS (not IP:port, not the
// tailnet), so the switch is disabled with the panel's reasons until then.

import { push, system } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { KeyValue } from "@seylo/ui/components/key-value";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Switch } from "@seylo/ui/components/switch";
import { IconExternalLink } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { formatRelative } from "../format";
import { useSettingsMutation } from "../mutation";
import { QueryView } from "../op-state";
import { SettingRow } from "../page";
import { SettingRowSkeleton } from "../skeletons";

const exampleKeys = ["apps", "nodes", "checks", "people"] as const;

export function AppPushCard() {
  const query = useOp(push.settings, {});
  const [confirmOff, setConfirmOff] = useState(false);
  const update = useSettingsMutation(push.updateSettings, {
    invalidates: [push.settings, push.mine, system.features],
    success: (output) => (output.enabled ? t("settingsPush.admin.turnedOn") : t("settingsPush.admin.turnedOff")),
  });

  return (
    <SectionCard title={t("settingsPush.admin.title")}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 text-[13.5px] text-muted-foreground">
          <p className="m-0">{t("settingsPush.admin.intro")}</p>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            {exampleKeys.map((key) => (
              <li key={key}>{t(`settingsPush.admin.examples.${key}`)}</li>
            ))}
          </ul>
          <p className="m-0">{t("settingsPush.admin.howItWorks")}</p>
        </div>
        <QueryView query={query} skeleton={<SettingRowSkeleton titleWidth="w-64" />}>
          {(data) => {
            const canTurnOn = data.blocks.length === 0;
            const description = data.enabled
              ? data.active
                ? t("settingsPush.admin.on", { url: data.domainUrl ?? "" })
                : t("settingsPush.admin.paused", { reason: pausedReason(data) })
              : canTurnOn
                ? t("settingsPush.admin.switchHint", { url: data.domainUrl ?? "" })
                : t("settingsPush.admin.blockedWhy");
            return (
              <>
                <SettingRow
                  title={t("settingsPush.admin.switch")}
                  description={description}
                  control={
                    <Switch
                      checked={data.enabled}
                      // Off always works; on only where the panel would allow it.
                      disabled={update.isPending || (!data.enabled && !canTurnOn)}
                      aria-label={t("settingsPush.admin.switch")}
                      onCheckedChange={(enabled) => {
                        if (!enabled && data.devices > 0) setConfirmOff(true);
                        else update.mutate({ enabled });
                      }}
                    />
                  }
                />
                {!data.enabled && !canTurnOn && (
                  <Alert
                    tone="neutral"
                    title={t("settingsPush.admin.blockedTitle")}
                    action={
                      data.domainUrl && !data.onDomainNow && !data.blocks.some((block) => block.code === "domainNotActive") ? (
                        <Button variant="secondary" size="sm" asChild>
                          <a href={`${data.domainUrl}/settings/notifications`}>
                            {t("settingsPush.admin.open", { url: data.domainUrl })}
                            <IconExternalLink size={14} aria-hidden="true" />
                          </a>
                        </Button>
                      ) : undefined
                    }
                  >
                    <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
                      {data.blocks.map((block) => (
                        <li key={block.code}>{block.message}</li>
                      ))}
                    </ul>
                  </Alert>
                )}
                {data.enabled && (
                  <KeyValue
                    items={[
                      { label: t("settingsPush.admin.people"), value: String(data.people) },
                      { label: t("settingsPush.admin.devices"), value: String(data.devices) },
                      ...(data.changedAt
                        ? [
                            {
                              label: t("settingsPush.admin.changed"),
                              value: data.changedBy
                                ? t("settingsPush.admin.changedBy", { when: formatRelative(data.changedAt), who: data.changedBy })
                                : formatRelative(data.changedAt),
                            },
                          ]
                        : []),
                    ]}
                  />
                )}
                <ConfirmDialog
                  open={confirmOff}
                  onOpenChange={setConfirmOff}
                  title={t("settingsPush.admin.confirmOffTitle")}
                  description={t("settingsPush.admin.confirmOff")}
                  confirmLabel={t("settingsPush.admin.confirmOffButton")}
                  destructive
                  onConfirm={async () => {
                    await update.mutateAsync({ enabled: false });
                  }}
                />
              </>
            );
          }}
        </QueryView>
      </div>
    </SectionCard>
  );
}

function pausedReason(data: push.AppPushSettings): string {
  return data.domainUrl ? `${data.domainUrl} does not work right now.` : "the panel has no domain.";
}
