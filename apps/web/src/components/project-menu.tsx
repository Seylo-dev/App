// The "..." menu of a project in the sidebar and on its home page card:
// Hide project, or Unhide project for one that is hidden. Hiding is the
// person's own choice (use-hidden-projects.ts); nobody else's view changes.

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@seylo/ui/components/dropdown-menu";
import { cn } from "@seylo/ui/lib/utils";
import { IconDots, IconEye, IconEyeOff } from "@tabler/icons-react";
import { t } from "../i18n/t";

export function ProjectMenu({
  name,
  hidden,
  onHiddenChange,
  className,
}: {
  name: string;
  hidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-project-menu=""
          aria-label={t("sidebar.projectMenu", { name })}
          className={cn("flex cursor-pointer rounded-chip border-0 bg-transparent p-1 text-ink-faint hover:text-foreground", className)}
        >
          <IconDots size={15} stroke={2} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => onHiddenChange(!hidden)}>
          {hidden ? <IconEye size={15} stroke={2} /> : <IconEyeOff size={15} stroke={2} />}
          {t(hidden ? "sidebar.unhideProject" : "sidebar.hideProject")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
