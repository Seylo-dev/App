import { IconCheck, IconChevronRight } from "@tabler/icons-react";
import { DropdownMenu as Menu } from "radix-ui";
import type * as React from "react";
import { popperMotion } from "../lib/overlay-motion";
import { cn } from "../lib/utils";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuSub = Menu.Sub;
export const DropdownMenuRadioGroup = Menu.RadioGroup;

const surface = cn(
  "z-50 min-w-44 overflow-hidden rounded-control bg-popover p-1 text-popover-foreground shadow-popover outline-none",
  popperMotion,
);

const item =
  "relative flex cursor-pointer select-none items-center gap-2 rounded-chip px-2.5 py-[7px] text-[13px] text-ink-strong outline-none transition-interactive data-[disabled]:pointer-events-none data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[disabled]:opacity-50 [&_svg]:shrink-0 [&_svg]:text-ink-faint";

export function DropdownMenuContent({ className, sideOffset = 6, align = "end", ...props }: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        data-slot="dropdown-menu"
        sideOffset={sideOffset}
        align={align}
        className={cn(surface, "origin-(--radix-dropdown-menu-content-transform-origin)", className)}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
  className,
  destructive = false,
  ...props
}: React.ComponentProps<typeof Menu.Item> & { destructive?: boolean }) {
  return (
    <Menu.Item
      className={cn(
        item,
        destructive && "text-chip-red-fg data-[highlighted]:bg-chip-red-bg data-[highlighted]:text-chip-red-fg [&_svg]:text-chip-red-fg",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem className={cn(item, "pr-8", className)} {...props}>
      {children}
      <Menu.ItemIndicator className="absolute right-2.5 flex">
        <IconCheck size={14} stroke={2.2} className="text-primary" />
      </Menu.ItemIndicator>
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(item, "pr-8", className)} {...props}>
      {children}
      <Menu.ItemIndicator className="absolute right-2.5 flex">
        <span className="size-1.5 rounded-full bg-primary" />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Menu.Label>) {
  return <Menu.Label className={cn("px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-muted-foreground", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn("-mx-1 my-1 h-px bg-divider", className)} {...props} />;
}

export function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("ml-auto font-mono text-[11px] text-ink-ghost", className)} {...props} />;
}

export function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof Menu.SubTrigger>) {
  return (
    <Menu.SubTrigger className={cn(item, "data-[state=open]:bg-muted", className)} {...props}>
      {children}
      <IconChevronRight size={14} className="ml-auto" />
    </Menu.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof Menu.SubContent>) {
  return (
    <Menu.Portal>
      <Menu.SubContent className={cn(surface, "origin-(--radix-dropdown-menu-content-transform-origin)", className)} {...props} />
    </Menu.Portal>
  );
}
