import type * as React from "react";
import { Fragment } from "react";
import { cn } from "../lib/utils";

export interface KeyValueItem {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Monospace value (ids, hashes, addresses). */
  mono?: boolean;
  /** Stable key when labels are not strings. */
  key?: string;
}

/** A mono string with a line-break chance after each "/", so a URL wraps between its parts. */
function breakable(item: KeyValueItem): React.ReactNode {
  if (!item.mono || typeof item.value !== "string" || !item.value.includes("/")) return item.value;
  const parts = item.value.split(/(?<=\/)(?!\/)/);
  // One inline span, so a flex row (the "rows" layout) does not turn each part into its own item.
  return (
    <span className="min-w-0">
      {parts.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string.
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

/**
 * Label and value rows (service details, node facts, a deploy's metadata).
 * "rows" puts each pair on a line with dividers; "grid" packs pairs into
 * columns with the label above the value (a few pairs share the whole
 * width). Either way a long value (a URL, a hostname) wraps; nothing ends
 * in an ellipsis. A monospace URL breaks after a "/" before anywhere else,
 * and mono and sans values share one line height, so a row lines up.
 */
export function KeyValue({ items, layout = "rows", className }: { items: KeyValueItem[]; layout?: "rows" | "grid"; className?: string }) {
  if (layout === "grid") {
    return (
      <dl data-slot="key-value" className={cn("m-0 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-x-6 gap-y-4", className)}>
        {items.map((item, i) => (
          <div key={item.key ?? (typeof item.label === "string" ? item.label : i)} className="flex min-w-0 flex-col gap-1">
            <dt className="text-[12px] text-muted-foreground">{item.label}</dt>
            <dd
              className={cn(
                "m-0 min-w-0 text-[13.5px] leading-5 font-medium [overflow-wrap:anywhere] text-foreground",
                item.mono && "font-mono text-[12.5px]",
              )}
            >
              {breakable(item)}
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
              "m-0 flex min-w-0 flex-1 items-center gap-2 text-[13.5px] leading-5 [overflow-wrap:anywhere] text-foreground",
              item.mono && "font-mono text-[12.5px]",
            )}
          >
            {breakable(item)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
