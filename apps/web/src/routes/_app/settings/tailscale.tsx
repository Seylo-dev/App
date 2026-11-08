// Settings > Tailscale (added in 0.2.1): the panel on the owner's own
// tailnet, through the tailscaled already on the panel server. Three cards:
// what the server's Tailscale is (install, sign in, warnings), the "Serve
// the panel on my tailnet" switch, and Lock to Tailscale, which closes
// public IP access from a page opened on the tailnet.

import { tailscale } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { QueryView } from "../../../components/settings/op-state";
import { SettingsPage } from "../../../components/settings/page";
import { SettingRowSkeleton } from "../../../components/settings/skeletons";
import { LockChecklist } from "../../../components/settings/tailscale/lock-checklist";
import { ServeSwitch } from "../../../components/settings/tailscale/serve-switch";
import { StatusCard } from "../../../components/settings/tailscale/status-card";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/tailscale")({
  component: TailscalePage,
});

function TailscalePage() {
  const query = useOp(tailscale.get, {});
  return (
    <SettingsPage title={t("settingsTailscale.title")} subtitle={t("settingsTailscale.subtitle")}>
      <QueryView query={query} skeleton={<TailscaleSkeleton />} className="flex flex-col gap-4">
        {(status) => (
          <div className="flex flex-col gap-4">
            <StatusCard status={status} />
            {status.detected && <ServeSwitch status={status} />}
            {status.serve.wanted && <LockChecklist status={status} />}
          </div>
        )}
      </QueryView>
    </SettingsPage>
  );
}

function TailscaleSkeleton() {
  return (
    <>
      <SectionCardSkeleton titleWidth="w-48" description="w-80">
        <div className="flex items-center gap-2">
          <Skeleton className="h-[22px] w-20 rounded-chip" />
          <SkeletonText className="w-64 text-[13px]" />
        </div>
        <Skeleton className="h-[38px] w-40" />
      </SectionCardSkeleton>
      <SectionCardSkeleton titleWidth="w-56" description="w-96">
        <SettingRowSkeleton titleWidth="w-52" />
      </SectionCardSkeleton>
    </>
  );
}
