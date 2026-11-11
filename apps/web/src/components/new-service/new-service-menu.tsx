// The "New service" menu (Project.dc.html): app, database, compose stack,
// template, Docker Hub image, Box, cron job and import from a file.
// Choosing one opens the matching form, the catalog (its Templates or
// Docker Hub tab) or the import page.

import { Button } from "@seylo/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@seylo/ui/components/dropdown-menu";
import { IconChevronDown, IconPlus } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { useShell } from "../shell/shell-context";
import { KindBadge, type NewServiceKind, newServiceKinds } from "./kinds";

/** Opens the right flow for a kind; `projectId` is preselected when given. */
export function useStartNewService() {
  const shell = useShell();
  const navigate = useNavigate();
  return (kind: NewServiceKind, projectId?: string) => {
    if (kind === "import") {
      void navigate({ to: "/import", search: projectId ? { project: projectId } : {} });
    } else if (kind === "template" || kind === "dockerHub") {
      void navigate({
        to: "/templates",
        search: { ...(projectId ? { project: projectId } : {}), ...(kind === "dockerHub" ? { tab: "docker-hub" as const } : {}) },
      });
    } else shell.openNewService(kind, projectId);
  };
}

export function NewServiceMenu({ projectId, trigger }: { projectId?: string; trigger?: ReactNode }) {
  const start = useStartNewService();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <Button variant="primary">
            {!projectId && <IconPlus size={15} stroke={2.2} aria-hidden="true" />}
            {t("newService.title")}
            {projectId && <IconChevronDown size={14} stroke={2.2} aria-hidden="true" />}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={t("newService.title")} className="w-[322px] p-1.5">
        {newServiceKinds.map((item) => (
          <DropdownMenuItem key={item.kind} onSelect={() => start(item.kind, projectId)} className="items-center gap-3 px-2.5 py-2">
            <KindBadge tag={item.tag} tone={item.tone} />
            <span className="flex min-w-0 flex-col gap-px">
              <span className="text-[13.5px] font-semibold text-foreground">{t(item.title)}</span>
              <span className="text-[12.5px] leading-snug text-muted-foreground">{t(item.description)}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
