// Settings > Telemetry: the opt-in switch for anonymous usage reports and
// the exact JSON the next report would send, so people can read what
// leaves their panel before they switch it on.

import { settings, telemetry } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { KeyValue } from "@seylo/ui/components/key-value";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Switch } from "@seylo/ui/components/switch";
import { createFileRoute } from "@tanstack/react-router";
import { formatDateTime, formatRelative } from "../../../components/settings/format";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { QueryView } from "../../../components/settings/op-state";
import { SettingRow, SettingsPage } from "../../../components/settings/page";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/telemetry")({
  component: TelemetryPage,
});

function TelemetryPage() {
  const state = useOp(settings.telemetry, {});
  const preview = useOp(telemetry.preview, {});
  const update = useSettingsMutation(settings.updateTelemetry, {
    invalidates: [settings.telemetry, telemetry.preview],
    success: (out) => (out.enabled ? t("settings.telemetry.turnedOn") : t("settings.telemetry.turnedOff")),
  });

  return (
    <SettingsPage title={t("settings.telemetry.title")} subtitle={t("settings.telemetry.subtitle")}>
      <SectionCard>
        <QueryView query={state} skeletonRows={1}>
          {(data) => (
            <>
              <SettingRow
                title={t("settings.telemetry.switch")}
                description={t("settings.telemetry.switchHint")}
                control={
                  <Switch
                    checked={data.enabled}
                    disabled={update.isPending}
                    aria-label={t("settings.telemetry.switch")}
                    onCheckedChange={(enabled) => update.mutate({ enabled })}
                  />
                }
              />
              <KeyValue
                items={[
                  { label: t("settings.telemetry.installId"), value: data.installId, mono: true },
                  {
                    label: t("settings.telemetry.lastSent"),
                    value: data.lastSentAt ? formatDateTime(data.lastSentAt) : t("settings.never"),
                  },
                ]}
              />
            </>
          )}
        </QueryView>
      </SectionCard>

      <SectionCard title={t("settings.telemetry.previewTitle")} description={t("settings.telemetry.previewDescription")}>
        <QueryView query={preview} skeletonRows={4}>
          {(data) => (
            <>
              <KeyValue
                layout="grid"
                items={[
                  { label: t("settings.telemetry.endpoint"), value: data.endpoint, mono: true },
                  { label: t("settings.telemetry.interval"), value: t("settings.telemetry.every", { count: data.intervalHours }) },
                  {
                    label: t("settings.telemetry.next"),
                    value: data.enabled && data.nextSendAt ? formatRelative(data.nextSendAt) : t("settings.telemetry.notScheduled"),
                  },
                ]}
              />
              <CodeBlock title={t("settings.telemetry.payload")} code={JSON.stringify(data.payload, null, 2)} maxHeight={420} />
              <p className="m-0 text-[12.5px] text-muted-foreground">{t("settings.telemetry.never")}</p>
            </>
          )}
        </QueryView>
      </SectionCard>
    </SettingsPage>
  );
}
