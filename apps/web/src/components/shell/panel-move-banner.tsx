// The app shell's line while the panel moves to another server (0.2.8):
// every page, for everyone signed in, because the panel refuses every
// change meanwhile. On an old copy a move left behind it says where the
// panel is now: its new IP address first (the domain's DNS record still
// points at the old server right after a move), the domain second. A page
// that only saw the old panel stop answering after the switch says the
// same; one that saw it stop before the switch says where the panel is if
// the move finished (lib/panel-move.ts). panelMove.status gives people
// without settings.view the state and the target's name only.

import { type OpOutput, panelMove } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { cn } from "@seylo/ui/lib/utils";
import { IconExternalLink, IconTruckDelivery } from "@tabler/icons-react";
import { t } from "../../i18n/t";
import { followMovePoll, lostMove, movedLinks } from "../../lib/panel-move";

type Status = OpOutput<typeof panelMove.status>;

export function PanelMoveBanner({ className }: { className?: string }) {
  const status = useOp(panelMove.status, {}, { refetchInterval: followMovePoll(5000) });
  if (!status.data) return null;
  const lost = lostMove(status);
  return <PanelMoveBannerView status={lost?.status ?? status.data} lost={lost !== null && !lost.moved} className={className} />;
}

/** `lost`: this server stopped answering before the switch went ahead, so the move may or may not have finished. */
export function PanelMoveBannerView({ status, lost = false, className }: { status: Status; lost?: boolean; className?: string }) {
  const moving = status.state === "running";
  const moved = status.state === "done" && status.side === "old";
  if (!moving && !moved) return null;
  const node = status.targetNodeName ?? "";
  const unsure = moving && lost;
  const { url, domainUrl } = moved || unsure ? movedLinks(status) : { url: null, domainUrl: null };
  const text = moved
    ? t("settingsPanelMove.banner.moved", { node })
    : unsure
      ? t("settingsPanelMove.banner.lost", { node })
      : status.waitingSince
        ? t("settingsPanelMove.banner.waiting", { node })
        : t("settingsPanelMove.banner.moving", { node });
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
        <span>{text}</span>
      </span>
      {domainUrl && (
        <span className="py-1 text-muted-foreground">
          <a href={domainUrl} className="font-medium text-link hover:text-link-hover">
            {status.domain}
          </a>{" "}
          {t("settingsPanelMove.banner.domain")}
        </span>
      )}
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
