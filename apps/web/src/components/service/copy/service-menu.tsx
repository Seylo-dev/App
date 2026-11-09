// The "..." menu next to a service's run actions: Clone and Move to
// project. The panel's own service has neither; a compose stack is not
// cloned or moved as a whole, and its members move with it.

import { Button } from "@seylo/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@seylo/ui/components/dropdown-menu";
import { IconArrowsExchange, IconCopy, IconDots } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { isPanelService } from "../../../lib/service-display";
import type { ServiceDetail } from "../use-service";
import { CloneDialog } from "./clone-dialog";
import { MoveProjectDialog } from "./move-project-dialog";

export function ServiceMenu({ service }: { service: ServiceDetail }) {
  const [open, setOpen] = useState<"clone" | "move" | null>(null);
  if (isPanelService(service) || service.protected) return null;
  const canClone = service.kind !== "compose";
  const canMove = service.kind !== "compose" && service.parentId === null;
  if (!canClone && !canMove) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* As tall as the Restart, Stop and Deploy buttons beside it in the header. */}
          <Button size="icon" variant="ghost" className="size-[38px] rounded-control" aria-label={t("serviceCopy.menu.label")}>
            <IconDots size={16} stroke={2} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {canClone && (
            <DropdownMenuItem onSelect={() => setOpen("clone")}>
              <IconCopy size={15} stroke={2} />
              {t("serviceCopy.menu.clone")}
            </DropdownMenuItem>
          )}
          {canMove && (
            <DropdownMenuItem onSelect={() => setOpen("move")}>
              <IconArrowsExchange size={15} stroke={2} />
              {t("serviceCopy.menu.moveProject")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Mounted only while open, so each opening starts from the service's current place. */}
      {open === "clone" && <CloneDialog service={service} open onOpenChange={(o) => setOpen(o ? "clone" : null)} />}
      {open === "move" && <MoveProjectDialog service={service} open onOpenChange={(o) => setOpen(o ? "move" : null)} />}
    </>
  );
}
