// Loading placeholders shaped like the settings building blocks in
// page.tsx (Field, SettingRow, FormActions), so a settings screen keeps
// its layout while its data loads.

import { ButtonSkeleton, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";

/** Field: label, a 38px control and (by default) a hint line. */
export function FieldSkeleton({
  span = false,
  hint = true,
  labelWidth = "w-24",
  className,
}: {
  span?: boolean;
  hint?: boolean;
  labelWidth?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", span && "sm:col-span-2", className)}>
      <SkeletonText className={cn("text-[12.5px]", labelWidth)} />
      <Skeleton className="h-[38px]" />
      {hint && <SkeletonText className="w-48 text-xs" />}
    </div>
  );
}

/** SettingRow: title and (unless `description` is false) description on the left, a switch (or a small button) on the right. */
export function SettingRowSkeleton({
  titleWidth = "w-40",
  control = "switch",
  description = true,
}: {
  titleWidth?: string;
  control?: "switch" | "button";
  description?: boolean;
}) {
  return (
    <div className="flex items-center gap-4 border-t border-divider py-3 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <SkeletonText className={cn("text-[13.5px]", titleWidth)} />
        {description && <SkeletonText className="w-80 text-[12.5px]" />}
      </div>
      {control === "switch" ? <Skeleton className="h-5 w-9 shrink-0 rounded-full" /> : <ButtonSkeleton size="sm" className="shrink-0" />}
    </div>
  );
}

/** FormActions with one button on the right. */
export function FormActionsSkeleton({ width = "w-16" }: { width?: string }) {
  return (
    <div className="flex justify-end pt-1">
      <ButtonSkeleton className={width} />
    </div>
  );
}
