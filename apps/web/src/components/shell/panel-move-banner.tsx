// The app shell's line while the panel moves to another server (0.2.8):
// every page, for everyone signed in, because the panel refuses every
// change meanwhile. On an old copy a move left behind it says where the
// panel is now. panelMove.status gives people without settings.view the
// state and the target's name only.

import { type OpOutput, panelMove } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { cn } from "@seylo/ui/lib/utils";
import { IconExternalLink, IconTruckDelivery } from "@tabler/icons-react";
import { t } from "../../i18n/t";

type Status = OpOutput<typeof panelMove.status>;

export function PanelMoveBanner({ className }: { className?: string }) {
  const status = useOp(panelMove.status, {}, { refetchInterval: (query) => (query.state.data?.state === "running" ? 5000 : false) });
  if (!status.data) return null;
  return <PanelMoveBannerView status={status.data} className={className} />;
}

export function PanelMoveBannerView({ status, className }: { status: Status; className?: string }) {
  const moving = status.state === "running";
  const moved = status.state === "done" && status.side === "old";
  if (!moving && !moved) return null;
  const node = status.targetNodeName ?? "";
  const url = moved ? (status.domain ? `https://${status.domain}` : status.newUrl) : null;
  return (
    <div
      role="status"
      data-testid="panel-move-banner"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card bg-card px-4 py-2 text-[13px] text-ink-strong shadow-card",
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 basis-60 items-center gap-2.5 py-1">
        <IconTruckDelivery size={16} stroke={1.9} className="shrink-0 text-ink-faint" aria-hidden="true" />
        <span>{moving ? t("settingsPanelMove.banner.moving", { node }) : t("settingsPanelMove.banner.moved", { node })}</span>
      </span>
      {url && (
        <Button asChild size="sm" variant="ghost" className="-mr-2 ml-auto">
          <a href={url}>
            {t("settingsPanelMove.banner.open")}
            <IconExternalLink size={14} aria-hidden="true" />
          </a>
        </Button>
      )}
    </div>
  );
}
