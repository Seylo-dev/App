import { IconX } from "@tabler/icons-react";
import { cva, type VariantProps } from "class-variance-authority";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { overlayMotion } from "../lib/overlay-motion";
import { cn } from "../lib/utils";
import { useUiLabels } from "./labels";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const sheetVariants = cva(
  "fixed z-50 flex flex-col gap-4 bg-popover text-popover-foreground shadow-popover outline-none duration-200 ease-out data-[state=open]:animate-in data-[state=closed]:animate-out",
  {
    variants: {
      side: {
        right:
          "inset-y-0 right-0 h-full w-[calc(100%-32px)] max-w-md data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
        left: "inset-y-0 left-0 h-full w-[calc(100%-32px)] max-w-md data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
        bottom:
          "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-card data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
      },
    },
    defaultVariants: { side: "right" },
  },
);

/** A panel that slides in from an edge: details, quick edits, the Files popup on small screens. */
export function SheetContent({
  className,
  side,
  children,
  hideClose = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & VariantProps<typeof sheetVariants> & { hideClose?: boolean }) {
  const labels = useUiLabels();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={cn("fixed inset-0 z-50 bg-foreground/20", overlayMotion)} />
      <DialogPrimitive.Content data-slot="sheet" className={cn(sheetVariants({ side }), className)} {...props}>
        {children}
        {!hideClose && (
          <DialogPrimitive.Close
            aria-label={labels.close}
            className="absolute top-4 right-4 flex size-8 cursor-pointer items-center justify-center rounded-control border-0 bg-muted text-ink-strong transition-interactive hover:text-foreground"
          >
            <IconX size={14} stroke={2.2} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5 px-5 pt-5 pr-14", className)} {...props} />;
}

export function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5", className)} {...props} />;
}

export function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-auto flex justify-end gap-2 border-t border-divider px-5 py-4", className)} {...props} />;
}

export function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("m-0 text-base font-semibold", className)} {...props} />;
}

export function SheetDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("m-0 text-[13px] text-muted-foreground", className)} {...props} />;
}
