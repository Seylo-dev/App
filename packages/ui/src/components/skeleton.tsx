import type * as React from "react";
import { cn } from "../lib/utils";

/**
 * A loading placeholder: a muted block with a soft light sweep (still for
 * people who ask for reduced motion). Size it like the content it stands
 * for, so nothing moves when the data arrives; the region that loads gets
 * aria-busy (LoadingRegion), the placeholder itself is hidden from screen
 * readers.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("relative rounded-control bg-muted skeleton-shimmer", className)}
      {...props}
    />
  );
}

/**
 * One line of text while it loads. Give it the text's own size classes
 * (text-[13px], leading-relaxed, ...) and a width: the line box is exactly
 * one line high (1lh), with a bar the height of the letters inside, so the
 * text takes the same room when it arrives.
 */
export function SkeletonText({ className, ground = false, ...props }: React.ComponentProps<"span"> & { ground?: boolean }) {
  return (
    <span aria-hidden="true" className={cn("flex h-[1lh] max-w-full items-center", className)} {...props}>
      <span
        data-slot="skeleton"
        // On the page ground (not on a card) the muted fill would vanish, so it takes the track tone.
        className={cn("relative block h-[0.72em] w-full rounded-chip skeleton-shimmer", ground ? "bg-track" : "bg-muted")}
      />
    </span>
  );
}

/** Wraps placeholders: tells assistive tech that this part of the page is loading. */
export function LoadingRegion({ label, className, ...props }: React.ComponentProps<"div"> & { label: string }) {
  return <div role="status" aria-busy="true" aria-label={label} className={className} {...props} />;
}

/** A form field while it loads: the label line, a 38px control and, with `hint`, a hint line. */
export function FieldSkeleton({
  labelWidth = "w-24",
  hint = false,
  className,
}: {
  labelWidth?: string;
  hint?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <SkeletonText className={cn("text-[13px]", labelWidth)} />
      <Skeleton className="h-[38px]" />
      {hint && <SkeletonText className="w-56 text-xs" />}
    </div>
  );
}

/** A button while its label loads or the screen around it does: `size` as on Button, width by class. */
export function ButtonSkeleton({ size = "default", className }: { size?: "default" | "sm" | "icon"; className?: string }) {
  return (
    <Skeleton
      className={cn(
        size === "default" && "h-[38px] w-20",
        size === "sm" && "h-8 w-16",
        size === "icon" && "size-[30px] rounded-chip",
        className,
      )}
    />
  );
}
