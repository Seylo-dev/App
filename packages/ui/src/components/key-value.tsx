import type * as React from "react";
import { cn } from "../lib/utils";

export interface KeyValueItem {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Monospace value (ids, hashes, addresses). */
  mono?: boolean;
  /** Stable key when labels are not strings. */
  key?: string;
}

/**
 * Label and value rows (service details, node facts, a deploy's metadata).
 * "rows" puts each pair on a line with dividers; "grid" packs pairs into
 * columns with the label above the value.
 */
export function KeyValue({ items, layout = "rows", className }: { items: KeyValueItem[]; layout?: "rows" | "grid"; className?: string }) {
  if (layout === "grid") {
    return (
      <dl data-slot="key-value" className={cn("m-0 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-6 gap-y-4", className)}>
        {items.map((item, i) => (
          <div key={item.key ?? (typeof item.label === "string" ? item.label : i)} className="flex min-w-0 flex-col gap-1">
            <dt className="text-[12px] text-muted-foreground">{item.label}</dt>
            <dd className={cn("m-0 min-w-0 truncate text-[13.5px] font-medium text-foreground", item.mono && "font-mono text-[12.5px]")}>
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl data-slot="key-value" className={cn("m-0 flex flex-col", className)}>
      {items.map((item, i) => (
        <div
          key={item.key ?? (typeof item.label === "string" ? item.label : i)}
          className="flex min-h-10 items-center gap-4 border-t border-divider py-2 first:border-t-0"
        >
          <dt className="w-28 shrink-0 text-[13px] text-muted-foreground sm:w-36">{item.label}</dt>
          <dd
            className={cn(
              "m-0 flex min-w-0 flex-1 items-center gap-2 text-[13.5px] [overflow-wrap:anywhere] text-foreground",
              item.mono && "font-mono text-[12.5px]",
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
