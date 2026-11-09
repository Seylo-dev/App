// A short numbered list of what to do, each number in a small filled
// circle (no outlines): the New app dialog's GitHub setup, Settings >
// GitHub's "Use a token".

import { cn } from "@seylo/ui/lib/utils";
import type { ReactNode } from "react";

export function NumberedSteps({ steps, className }: { steps: readonly ReactNode[]; className?: string }) {
  return (
    <ol className={cn("m-0 flex list-none flex-col gap-2 p-0", className)}>
      {steps.map((step, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the steps are fixed and keep their order
        <li key={index} className="flex items-start gap-2.5 text-[13px] leading-normal text-ink-strong">
          <span
            aria-hidden="true"
            className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground tabular-nums"
          >
            {index + 1}
          </span>
          <span className="min-w-0">{step}</span>
        </li>
      ))}
    </ol>
  );
}
