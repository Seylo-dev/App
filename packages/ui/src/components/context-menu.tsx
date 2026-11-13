// The right-click menu (shadcn's context-menu on Radix), with the same
// parts and look as the dropdown menu (lib/menu-styles.ts). It opens at the
// pointer on a right-click or a touch long-press, and at the focused
// element on the keyboard's context menu key or Shift+F10.
//
// ContextMenuTrigger adds what Radix leaves out: the browser's own menu
// stays where it is the better one (text fields, the code editors, the
// terminals, anything marked data-native-context-menu, a row with text
// selected in it, and Shift+right-click anywhere), nothing opens on a drag
// grip (data-no-context-menu) or while `blocked()` says so (a drag is on),
// and right-clicks that reach the trigger through a React portal (a dialog
// or a menu rendered inside the row) are not the row's. A touch or pen
// long-press follows the same rules: Radix opens the menu from a timer of
// its own (iOS sends no contextmenu event at all), so a press where a
// right-click would not open it holds the trigger disabled until the
// finger or pen lifts, which clears that timer. The fields and native
// areas also keep text selection and the link callout on a touch screen
// (styles/tailwind.css), where the row itself has neither.

import { IconCheck, IconChevronRight } from "@tabler/icons-react";
import { ContextMenu as Menu } from "radix-ui";
import * as React from "react";
import {
  menuIndicatorItem,
  menuItem,
  menuItemDestructive,
  menuLabel,
  menuSeparator,
  menuShortcut,
  menuSubTrigger,
  menuSurface,
} from "../lib/menu-styles";
import { cn } from "../lib/utils";

export const ContextMenu = Menu.Root;
export const ContextMenuGroup = Menu.Group;
export const ContextMenuSub = Menu.Sub;
export const ContextMenuRadioGroup = Menu.RadioGroup;

const origin = "origin-(--radix-context-menu-content-transform-origin) max-h-(--radix-context-menu-content-available-height)";

/** Where the browser's own menu is the better one: text fields, Monaco, xterm, or anything marked so. */
export const nativeMenuTargets =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), .monaco-editor, .xterm, [data-native-context-menu]";

/** Where no menu opens at all: a sortable item's drag grip. */
export const noMenuTargets = "[data-no-context-menu]";

/**
 * What was right-clicked, as far as the decision goes: a text field (or
 * editor, terminal), a drag grip, an open menu, something that is not
 * inside the trigger in the page (a dialog or menu rendered inside the row
 * through a portal), or the row itself.
 */
export type MenuTarget = "field" | "grip" | "menu" | "portal" | "row";

export interface MenuRequest {
  /** The event's mouse button: 2 for a right-click, 0 for the keyboard (and a macOS Control-click). */
  button: number;
  shiftKey: boolean;
  target: MenuTarget;
  /** Text was selected inside the trigger before this right-click. */
  hasSelection: boolean;
  /** The app says no menu now (a drag is on). */
  blocked?: boolean;
}

/**
 * "ours" opens the context menu, "native" leaves the browser's own menu,
 * "none" shows neither. Shift+right-click always gives the browser's menu;
 * Shift+F10 comes with button 0, so it still opens ours.
 */
export function contextMenuDecision(request: MenuRequest): "ours" | "native" | "none" {
  if (request.blocked) return "none";
  if (request.target === "menu" || request.target === "grip") return "none";
  if (request.target === "portal" || request.target === "field") return "native";
  if (request.button === 2 && request.shiftKey) return "native";
  if (request.hasSelection) return "native";
  return "ours";
}

/** The browser's own menu should show for this request (see contextMenuDecision). */
export function wantsNativeMenu(request: MenuRequest): boolean {
  return contextMenuDecision(request) === "native";
}

/** The key presses that ask for a context menu: the context menu key and Shift+F10. */
export function isMenuKey(event: { key: string; shiftKey: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

function classify(target: EventTarget | null, trigger: Element): MenuTarget {
  if (!(target instanceof Element)) return "row";
  if (target.closest("[role=menu]")) return "menu";
  if (!trigger.contains(target)) return "portal";
  if (target.closest(noMenuTargets)) return "grip";
  if (target.closest(nativeMenuTargets)) return "field";
  return "row";
}

function selectionIn(trigger: Element): boolean {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  for (let i = 0; i < selection.rangeCount; i++) if (selection.getRangeAt(i).intersectsNode(trigger)) return true;
  return false;
}

/**
 * The selection as it was before the right-click: Chrome and Safari on
 * macOS select the word under the pointer before the contextmenu event, so
 * it is read on pointerdown. Older than a second counts as not read.
 */
interface SelectionNote {
  at: number;
  had: boolean;
}

/**
 * What a touch or pen long-press here would do: the same as a right-click
 * on the same spot, without the selection rule (on a touch screen a
 * selection has its own handles and callout, and a row takes none).
 */
export function longPressDecision(target: MenuTarget, blocked: boolean): "ours" | "native" | "none" {
  return contextMenuDecision({ button: 2, shiftKey: false, target, hasSelection: false, blocked });
}

/**
 * A touch or pen press in progress on the trigger, and whether it holds the
 * trigger disabled. It ends when any pointer lifts or is cancelled, so a
 * press that ends elsewhere (or whose element went) never keeps the menu off.
 */
interface Press {
  held: boolean;
  end: () => void;
}

export function ContextMenuTrigger({
  blocked,
  disabled = false,
  onContextMenuCapture,
  onPointerDownCapture,
  onPointerDown,
  onKeyDown,
  className,
  ...props
}: React.ComponentProps<typeof Menu.Trigger> & {
  /** No menu while this answers true (the app passes "a drag is on"). */
  blocked?: () => boolean;
}) {
  const note = React.useRef<SelectionNote | null>(null);
  const press = React.useRef<Press | null>(null);
  // Disabled while a touch or pen press must not open the menu: Radix clears its long-press timer when the trigger turns disabled.
  const [held, setHeld] = React.useState(false);
  React.useEffect(() => () => press.current?.end(), []);
  const startPress = () => {
    press.current?.end();
    const current: Press = {
      held: false,
      end: () => {
        window.removeEventListener("pointerup", current.end, true);
        window.removeEventListener("pointercancel", current.end, true);
        if (press.current === current) press.current = null;
        if (current.held) setHeld(false);
      },
    };
    window.addEventListener("pointerup", current.end, true);
    window.addEventListener("pointercancel", current.end, true);
    press.current = current;
  };
  const hold = () => {
    const current = press.current;
    if (!current || current.held) return;
    current.held = true;
    setHeld(true);
  };
  return (
    <Menu.Trigger
      data-context-menu-trigger=""
      disabled={disabled || held}
      // Radix marks the trigger data-disabled while it is; a held press is not the row being disabled.
      data-disabled={disabled ? "" : undefined}
      className={cn("pointer-coarse:select-none", className)}
      onPointerDownCapture={(event) => {
        onPointerDownCapture?.(event);
        // A right-click, or Control-click on a Mac: what was selected before the browser selects a word.
        if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
          note.current = { at: performance.now(), had: selectionIn(event.currentTarget) };
        }
        if (event.pointerType !== "mouse") startPress();
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        // A long-press where a right-click would open no menu of ours (a field, a native area, a grip, an open
        // "..." menu or a dialog inside the row, or while a drag is on) leaves the browser's long-press alone.
        if (event.pointerType === "mouse") return;
        if (longPressDecision(classify(event.target, event.currentTarget), blocked?.() ?? false) !== "ours") hold();
      }}
      onContextMenuCapture={(event) => {
        onContextMenuCapture?.(event);
        const trigger = event.currentTarget;
        const recent = note.current && performance.now() - note.current.at < 1000 ? note.current : null;
        note.current = null;
        // Ours from the key below (not the browser's): a page's own event shows no browser menu, so a selection does not count.
        const fromKey = !event.nativeEvent.isTrusted;
        const hadSelection = fromKey ? false : recent ? recent.had : selectionIn(trigger);
        const decision = contextMenuDecision({
          button: event.button,
          shiftKey: event.shiftKey,
          target: classify(event.target, trigger),
          hasSelection: hadSelection,
          blocked: blocked?.() ?? false,
        });
        // The contextmenu of a long-press (Android) that is not ours: Radix's long-press timer must not open the menu after it.
        if (decision !== "ours") hold();
        if (decision === "native") {
          // Radix's handler (bubble phase) never runs, and the browser shows its own menu.
          event.stopPropagation();
        } else if (decision === "none") {
          event.preventDefault();
          event.stopPropagation();
        } else if (!hadSelection && selectionIn(trigger)) {
          // The word the browser just selected under the pointer is not what the menu is about.
          window.getSelection()?.removeAllRanges();
        }
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || !isMenuKey(event)) return;
        const target = event.target;
        if (!(target instanceof Element) || classify(target, event.currentTarget) === "field") return;
        // Browsers without the key (macOS) and the ones with it alike: open at the focused element.
        event.preventDefault();
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: rect.left + Math.min(rect.width / 2, 24),
            clientY: rect.top + rect.height / 2,
          }),
        );
      }}
      {...props}
    />
  );
}

/**
 * Whether the menu, once closed, should leave focus where it is instead of
 * moving it back to what had it when the menu opened: yes when something
 * outside the menu took focus meanwhile (an item started an inline rename,
 * opened a dialog). When the menu just closed (Escape, a click outside, an
 * item that moved nothing), focus fell to the page with the menu's items
 * and goes back, so the keyboard stays on the row.
 */
export function keepsFocusOnClose(active: Element | null, body: Element | null): boolean {
  return active !== null && active !== body;
}

export function ContextMenuContent({ className, onContextMenu, onCloseAutoFocus, ...props }: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        data-slot="context-menu"
        className={cn(menuSurface, origin, className)}
        // A right-click inside the open menu opens nothing (neither ours again nor the browser's).
        onContextMenu={(event) => {
          onContextMenu?.(event);
          event.preventDefault();
        }}
        // What had focus when the menu opened is not the row in every browser (Safari and Firefox on macOS do not
        // focus a button on click): moving focus back there would blur a rename field an item just opened.
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (!event.defaultPrevented && keepsFocusOnClose(document.activeElement, document.body)) event.preventDefault();
        }}
        {...props}
      />
    </Menu.Portal>
  );
}

export function ContextMenuItem({
  className,
  destructive = false,
  ...props
}: React.ComponentProps<typeof Menu.Item> & { destructive?: boolean }) {
  return <Menu.Item className={cn(menuItem, destructive && menuItemDestructive, className)} {...props} />;
}

export function ContextMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem className={cn(menuItem, menuIndicatorItem, className)} {...props}>
      {children}
      <Menu.ItemIndicator className="absolute right-2.5 flex">
        <IconCheck size={14} stroke={2.2} className="text-primary" />
      </Menu.ItemIndicator>
    </Menu.CheckboxItem>
  );
}

export function ContextMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(menuItem, menuIndicatorItem, className)} {...props}>
      {children}
      <Menu.ItemIndicator className="absolute right-2.5 flex">
        <span className="size-1.5 rounded-full bg-primary" />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  );
}

export function ContextMenuLabel({ className, ...props }: React.ComponentProps<typeof Menu.Label>) {
  return <Menu.Label className={cn(menuLabel, className)} {...props} />;
}

export function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn(menuSeparator, className)} {...props} />;
}

export function ContextMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn(menuShortcut, className)} {...props} />;
}

export function ContextMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof Menu.SubTrigger>) {
  return (
    <Menu.SubTrigger className={cn(menuItem, menuSubTrigger, className)} {...props}>
      {children}
      <IconChevronRight size={14} className="ml-auto" />
    </Menu.SubTrigger>
  );
}

export function ContextMenuSubContent({ className, ...props }: React.ComponentProps<typeof Menu.SubContent>) {
  return (
    <Menu.Portal>
      <Menu.SubContent data-slot="context-menu" className={cn(menuSurface, origin, className)} {...props} />
    </Menu.Portal>
  );
}
