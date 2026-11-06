import { IconSearch } from "@tabler/icons-react";
import { Command as CommandPrimitive } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils";
import { Dialog, DialogContent } from "./dialog";

/** The command palette: a dialog with a filterable list of actions and places. */
export function CommandDialog({
  title,
  children,
  ...props
}: React.ComponentProps<typeof Dialog> & { title: string; children: React.ReactNode }) {
  return (
    <Dialog {...props}>
      <DialogContent className="overflow-hidden p-0">
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        <CommandPrimitive className="flex flex-col">{children}</CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}

export function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-divider px-4">
      <IconSearch size={16} className="text-muted-foreground" aria-hidden="true" />
      <CommandPrimitive.Input
        className={cn("h-12 w-full bg-transparent text-[14px] outline-none placeholder:text-ink-ghost", className)}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className={cn("max-h-80 overflow-y-auto p-2", className)} {...props} />;
}

export function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="px-3 py-6 text-center text-[13px] text-muted-foreground" {...props} />;
}

export function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-2 text-[13.5px] text-ink-strong transition-interactive data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}
