// A service's menu where it shows: the header's "..." button and the
// right-click menu of its sidebar row, dashboard card, list and table rows
// and project page card. Both render ServiceMenuItems, which builds the
// entries (service-items.tsx) when the menu opens, so a list of a hundred
// services asks for nothing until one menu is open.

import { services } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { ActionsMenu, type MenuEntry, MenuItems } from "@seylo/ui/components/menu-items";
import { IconDots } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { t } from "../../i18n/t";
import { isPanelService } from "../../lib/service-display";
import { useActiveDeploy } from "../service/active-deploy";
import { useTerminalModes } from "../service/terminal/access";
import { useObjectActions } from "./object-actions";
import { RowMenu } from "./row-menu";
import { type ServiceMenuSubject, serviceMenuEntries } from "./service-items";

export function useServiceMenu(service: ServiceMenuSubject): MenuEntry[] {
  const objects = useObjectActions();
  const here = useParams({ strict: false, select: (params) => params.serviceId === service.id });
  const deploys = (service.kind === "app" || service.kind === "cron") && !isPanelService(service);
  // The same query the header's Deploy waits on: the deploy in progress, if any.
  const active = useActiveDeploy(service.id, deploys);
  // A row has only the summary. On the service's own page its services.get
  // is live (the page reads it and follows service:<id>), so it says whether
  // the service is stopped; anywhere else a cached copy is whatever the page
  // last read, and a stop or start since (from this menu or anyone's) only
  // marked it stale, so the row's status is the newer word.
  const detail = useOp(services.get, { serviceId: service.id }, { enabled: false });
  const terminalModes = useTerminalModes(service);
  return serviceMenuEntries(service, {
    here,
    busy: active !== null || service.status === "building" || service.status === "deploying",
    stopped: here ? detail.data?.stopped : undefined,
    terminalModes,
    act: (action) => objects.serviceAction(service, action, active?.id),
  });
}

export function ServiceMenuItems({ as, service }: { as: "dropdown" | "context"; service: ServiceMenuSubject }) {
  return <MenuItems as={as} entries={useServiceMenu(service)} />;
}

/** The service header's "..." button: the same menu as the right-click one. */
export function ServiceActionsMenu({ service }: { service: ServiceMenuSubject }) {
  return (
    <ActionsMenu
      trigger={
        // As tall as the Restart, Stop and Deploy buttons beside it in the header.
        <Button size="icon" variant="ghost" className="size-[38px] rounded-control" aria-label={t("serviceCopy.menu.label")}>
          <IconDots size={16} stroke={2} />
        </Button>
      }
      items={<ServiceMenuItems as="dropdown" service={service} />}
    />
  );
}

/** `children` (the row's or card's own link) opens the service's menu on right-click, long-press or Shift+F10. */
export function ServiceContextMenu({ service, children }: { service: ServiceMenuSubject; children: ReactElement }) {
  return (
    <RowMenu items={<ServiceMenuItems as="context" service={service} />} aria-label={t("menus.actionsFor", { name: service.name })}>
      {children}
    </RowMenu>
  );
}
