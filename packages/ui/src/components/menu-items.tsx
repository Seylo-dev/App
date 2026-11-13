// One list of menu entries, shown as the "..." dropdown and as the
// right-click menu. A screen builds the entries once (plain data: label,
// icon, destructive, disabled and why, what selecting does) and hands the
// same array to ActionsMenu and RowContextMenu, which both render it
// through MenuItems, so the two menus never list different things.

import { IconDots } from "@tabler/icons-react";
import { Fragment, type ReactElement, type ReactNode, useRef } from "react";
import { cn } from "../lib/utils";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

export type MenuEntry =
  | {
      type: "item";
      /** Stable within the menu: tests and keys use it. */
      id: string;
      label: string;
      icon?: ReactNode;
      /** A key hint at the right, like "R". */
      shortcut?: string;
      destructive?: boolean;
      disabled?: boolean;
      /** Why it is disabled: the item's title, and a muted note at the end of the menu. */
      disabledReason?: string;
      onSelect: () => void;
    }
  | { type: "checkbox"; id: string; label: string; checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean }
  | { type: "sub"; id: string; label: string; icon?: ReactNode; entries: readonly MenuEntry[] }
  | { type: "label"; id: string; label: string }
  | { type: "separator"; id: string };

/** A separator entry; `id` only needs to be unique in its menu. */
export const separatorEntry = (id: string): MenuEntry => ({ type: "separator", id });

/**
 * The entries as they show: no separator at the start or the end or right
 * after another, and no sub menu without entries.
 */
export function tidyEntries(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    let next = entry;
    if (entry.type === "sub") {
      const inner = tidyEntries(entry.entries);
      if (inner.length === 0) continue;
      next = { ...entry, entries: inner };
    }
    if (next.type === "separator" && (out.length === 0 || out[out.length - 1]?.type === "separator")) continue;
    out.push(next);
  }
  while (out[out.length - 1]?.type === "separator") out.pop();
  return out;
}

/** Every selectable entry's id in order, sub menus' entries after their own: what a test compares between menus. */
export function entryIds(entries: readonly MenuEntry[]): string[] {
  return tidyEntries(entries).flatMap((entry) => {
    if (entry.type === "separator" || entry.type === "label") return [];
    if (entry.type === "sub") return [entry.id, ...entryIds(entry.entries)];
    return [entry.id];
  });
}

/** The building blocks of one kind of menu. */
export interface MenuParts {
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  CheckboxItem: typeof DropdownMenuCheckboxItem | typeof ContextMenuCheckboxItem;
  Label: typeof DropdownMenuLabel | typeof ContextMenuLabel;
  Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator;
  Shortcut: typeof DropdownMenuShortcut | typeof ContextMenuShortcut;
  Sub: typeof DropdownMenuSub | typeof ContextMenuSub;
  SubTrigger: typeof DropdownMenuSubTrigger | typeof ContextMenuSubTrigger;
  SubContent: typeof DropdownMenuSubContent | typeof ContextMenuSubContent;
}

export const menuParts: Record<"dropdown" | "context", MenuParts> = {
  dropdown: {
    Item: DropdownMenuItem,
    CheckboxItem: DropdownMenuCheckboxItem,
    Label: DropdownMenuLabel,
    Separator: DropdownMenuSeparator,
    Shortcut: DropdownMenuShortcut,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
  },
  context: {
    Item: ContextMenuItem,
    CheckboxItem: ContextMenuCheckboxItem,
    Label: ContextMenuLabel,
    Separator: ContextMenuSeparator,
    Shortcut: ContextMenuShortcut,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
  },
};

/**
 * The elements for `entries` in one kind of menu. Both kinds come from this
 * one function with the same props; only the parts differ.
 */
export function menuElements(as: "dropdown" | "context", entries: readonly MenuEntry[]): ReactElement[] {
  // The parts take the same props in both kinds; typed as the dropdown's so JSX accepts the union.
  const parts = menuParts[as] as MenuParts & {
    Item: typeof DropdownMenuItem;
    CheckboxItem: typeof DropdownMenuCheckboxItem;
    Label: typeof DropdownMenuLabel;
    Separator: typeof DropdownMenuSeparator;
    Shortcut: typeof DropdownMenuShortcut;
    Sub: typeof DropdownMenuSub;
    SubTrigger: typeof DropdownMenuSubTrigger;
    SubContent: typeof DropdownMenuSubContent;
  };
  const list = tidyEntries(entries);
  const elements = list.map((entry): ReactElement => {
    switch (entry.type) {
      case "separator":
        return <parts.Separator key={entry.id} />;
      case "label":
        return (
          <parts.Label key={entry.id} className="text-xs leading-normal font-normal whitespace-normal">
            {entry.label}
          </parts.Label>
        );
      case "checkbox":
        return (
          <parts.CheckboxItem
            key={entry.id}
            data-menu-id={entry.id}
            checked={entry.checked}
            disabled={entry.disabled}
            onCheckedChange={(checked) => entry.onCheckedChange(checked === true)}
          >
            {entry.label}
          </parts.CheckboxItem>
        );
      case "sub":
        return (
          <parts.Sub key={entry.id}>
            <parts.SubTrigger data-menu-id={entry.id}>
              {entry.icon}
              {entry.label}
            </parts.SubTrigger>
            <parts.SubContent>{menuElements(as, entry.entries)}</parts.SubContent>
          </parts.Sub>
        );
      default:
        return (
          <parts.Item
            key={entry.id}
            data-menu-id={entry.id}
            destructive={entry.destructive}
            disabled={entry.disabled}
            title={entry.disabled ? entry.disabledReason : undefined}
            onSelect={entry.onSelect}
          >
            {entry.icon}
            {entry.label}
            {entry.shortcut && <parts.Shortcut>{entry.shortcut}</parts.Shortcut>}
          </parts.Item>
        );
    }
  });
  // Why items are disabled, once each, at the end: a disabled item takes no pointer, so its title never shows.
  const reasons = [
    ...new Set(list.flatMap((entry) => (entry.type === "item" && entry.disabled && entry.disabledReason ? [entry.disabledReason] : []))),
  ];
  if (reasons.length > 0) {
    elements.push(<parts.Separator key="disabled-reasons-separator" />);
    for (const reason of reasons)
      elements.push(
        <parts.Label key={`disabled-reason:${reason}`} className="max-w-72 text-xs leading-normal font-normal whitespace-normal">
          {reason}
        </parts.Label>,
      );
  }
  return elements;
}

/** The entries as one kind of menu's items, inside its content. */
export function MenuItems({ as, entries }: { as: "dropdown" | "context"; entries: readonly MenuEntry[] }) {
  return <Fragment>{menuElements(as, entries)}</Fragment>;
}

/**
 * The right-click (and long-press) menu of one row or card. `children` is
 * the row's own element (the trigger takes it over with asChild, so the
 * layout does not change); while the menu is open it has
 * data-state="open", for the row's selected look. Give `entries`, or
 * `items` for menus that build their entries when they open (hooks
 * allowed). With no entries the row is left alone and keeps the browser's
 * menu. After a long-press opened the menu, the tap the finger's lift may
 * leave on the row is swallowed, so a link under it does not open.
 */
export function RowContextMenu({
  entries,
  items,
  children,
  disabled = false,
  blocked,
  onOpenChange,
  "aria-label": ariaLabel,
}: {
  entries?: readonly MenuEntry[];
  items?: ReactNode;
  children: ReactElement;
  /** Keeps the browser's menu for now (the row is being edited inline, say). */
  disabled?: boolean;
  /** No menu while this answers true (a drag is on). */
  blocked?: () => boolean;
  onOpenChange?: (open: boolean) => void;
  "aria-label"?: string;
}) {
  const pointer = useRef("mouse");
  const swallowTap = useRef(false);
  const list = entries ? tidyEntries(entries) : null;
  if (list && list.length === 0 && items === undefined) return children;
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open && pointer.current !== "mouse") swallowTap.current = true;
        onOpenChange?.(open);
      }}
    >
      <ContextMenuTrigger
        asChild
        disabled={disabled}
        blocked={blocked}
        onPointerDownCapture={(event) => {
          pointer.current = event.pointerType;
          swallowTap.current = false;
        }}
        onClickCapture={(event) => {
          if (!swallowTap.current || event.detail === 0) return;
          swallowTap.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={ariaLabel}>{items ?? <MenuItems as="context" entries={list ?? []} />}</ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The "..." menu of the same entries (or `items`, built when it opens).
 * `trigger` is the caller's button (so it keeps its own look and label);
 * without one a quiet dots button labelled `label` shows. Nothing renders
 * for an empty list.
 */
export function ActionsMenu({
  entries,
  items,
  trigger,
  label,
  align = "end",
  className,
}: {
  entries?: readonly MenuEntry[];
  items?: ReactNode;
  trigger?: ReactElement;
  /** The default button's accessible name, like "More actions for api". */
  label?: string;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const list = entries ? tidyEntries(entries) : null;
  if (list && list.length === 0 && items === undefined) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label={label}
            className={cn(
              "inline-flex size-[30px] cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent text-ink-faint transition-interactive hover:bg-muted hover:text-foreground data-[state=open]:bg-muted",
              className,
            )}
          >
            <IconDots size={16} aria-hidden="true" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>{items ?? <MenuItems as="dropdown" entries={list ?? []} />}</DropdownMenuContent>
    </DropdownMenu>
  );
}
