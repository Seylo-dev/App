// The Shell view's placeholder, in its own module: the node sheet shows it
// while the shell's code (xterm) loads, without importing that code.

import { ButtonSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { t } from "../../i18n/t";

export function ShellSkeleton() {
  return (
    <LoadingRegion label={t("nodeShell.loading")} className="flex flex-col items-start gap-3 rounded-control bg-raised p-4">
      <div className="flex items-center gap-2">
        <Skeleton className="size-[17px] shrink-0 rounded-[4px] bg-track" />
        <SkeletonText ground className="w-44 text-sm" />
      </div>
      <span className="flex w-full flex-col">
        <SkeletonText ground className="w-full text-[12.5px] leading-relaxed" />
        <SkeletonText ground className="w-2/3 text-[12.5px] leading-relaxed" />
      </span>
      <ButtonSkeleton size="sm" className="w-28 bg-track" />
    </LoadingRegion>
  );
}
