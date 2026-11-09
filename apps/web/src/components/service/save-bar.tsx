// The save strip of a service settings card. SectionCard's `footer` draws it
// for cards that hold their own state (Advanced, Notes); a form that keeps
// its state further down (a Source form, the alert rules) renders this as
// the last child of the card body instead, so every settings card saves
// from the same small button on the same quiet strip.

import { cn } from "@seylo/ui/lib/utils";
import type { ReactNode } from "react";

/** SectionCard's footer look, from inside the card body: it reaches out over the body's padding (px-5, pb-5) to the card edges. */
export function CardSaveBar({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      data-slot="card-save-bar"
      className={cn(
        "-mx-5 mt-2 -mb-5 flex flex-wrap items-center gap-2 border-t border-divider bg-raised px-5 py-3 text-[12.5px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
