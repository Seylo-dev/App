// The look every menu shares. The dropdown ("..." buttons,
// components/dropdown-menu.tsx) and the context menu (right-click and
// long-press, components/context-menu.tsx) build their parts from these
// strings, so the two never look different.

import { popperMotion } from "./overlay-motion";
import { cn } from "./utils";

/**
 * The floating panel. A long menu scrolls inside the room its side has
 * (each menu adds its own available-height variable and transform origin),
 * without a visible scrollbar.
 */
export const menuSurface = cn(
  "z-50 min-w-44 overflow-x-hidden overflow-y-auto rounded-control bg-popover p-1 text-popover-foreground shadow-popover outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
  popperMotion,
);

/** One row: icon, label and an optional shortcut hint. */
export const menuItem =
  "relative flex cursor-pointer select-none items-center gap-2 rounded-chip px-2.5 py-[7px] text-[13px] text-ink-strong outline-none transition-interactive data-[disabled]:pointer-events-none data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[disabled]:opacity-50 [&_svg]:shrink-0 [&_svg]:text-ink-faint";

/** What a destructive item (Delete, Remove) adds to menuItem. */
export const menuItemDestructive =
  "text-chip-red-fg data-[highlighted]:bg-chip-red-bg data-[highlighted]:text-chip-red-fg [&_svg]:text-chip-red-fg";

/** Room on the right for a checkbox or radio item's mark. */
export const menuIndicatorItem = "pr-8";

/** A sub menu's row stays filled while its sub menu is open. */
export const menuSubTrigger = "data-[state=open]:bg-muted";

export const menuLabel = "px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-muted-foreground";

export const menuSeparator = "-mx-1 my-1 h-px bg-divider";

export const menuShortcut = "ml-auto font-mono text-[11px] text-ink-ghost";
