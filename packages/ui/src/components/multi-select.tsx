import { IconChevronDown, IconX } from "@tabler/icons-react";
import { Command as CommandPrimitive } from "cmdk";
import * as React from "react";
import { cn } from "../lib/utils";
import { Checkbox } from "./checkbox";
import { Chip } from "./chip";
import { CommandEmpty, CommandInput, CommandItem, CommandList } from "./command";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./popover";
import { SkeletonText } from "./skeleton";

export interface MultiSelectOption {
  value: string;
  /** What the row and the chip show. */
  label: string;
  /** Muted text on the right of the row, for example a size. */
  hint?: string;
}

export interface MultiSelectProps {
  options: MultiSelectOption[];
  value: string[];
  onValueChange: (value: string[]) => void;
  "aria-label": string;
  id?: string;
  /** Shown while nothing is picked. */
  placeholder: string;
  searchPlaceholder: string;
  /** The list when nothing matches the search. */
  emptyText: string;
  /** The remove button of a chip, for example "Remove shop". */
  removeLabel: (label: string) => string;
  /** The chip of a picked value that is not among the options; the value itself without it. */
  labelOf?: (value: string) => string;
  /** A note for a picked value that needs attention (amber chip), or null. */
  warn?: (value: string) => string | null;
  /** The list cannot open; picked chips can still be removed. */
  disabled?: boolean;
  /** The options are on their way: a skeleton line, the list stays shut. */
  loading?: boolean;
  className?: string;
}

/**
 * Several choices from a searchable list: the picked ones as fill-only
 * chips in the field (each with its own remove button), the list in a
 * popover with a check per row and a hint on the right. A picked value
 * that is not among the options keeps its chip (its label is the value),
 * so a saved choice that is gone stays visible and removable.
 */
export function MultiSelect({
  options,
  value,
  onValueChange,
  id,
  placeholder,
  searchPlaceholder,
  emptyText,
  removeLabel,
  warn,
  labelOf,
  disabled = false,
  loading = false,
  className,
  ...rest
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const byValue = new Map(options.map((o) => [o.value, o]));
  const picked = new Set(value);
  const toggle = (v: string) => onValueChange(picked.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  const shut = disabled || loading;
  return (
    <Popover open={open && !shut} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          data-slot="multi-select"
          className={cn(
            "flex min-h-[38px] w-full min-w-0 flex-wrap items-center gap-1.5 rounded-control border border-input bg-card py-1 pr-1 pl-1.5 text-[13.5px] transition-interactive",
            "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/15",
            className,
          )}
        >
          {value.map((v) => {
            const label = byValue.get(v)?.label ?? labelOf?.(v) ?? v;
            const note = warn?.(v) ?? null;
            return (
              <Chip key={v} tone={note ? "amber" : "track"} className="max-w-full gap-1 pr-1">
                <span className="truncate">{label}</span>
                {note && <span className="font-normal opacity-80">{note}</span>}
                <button
                  type="button"
                  className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] opacity-70 transition-interactive hover:bg-black/5 hover:opacity-100"
                  aria-label={removeLabel(label)}
                  onClick={() => toggle(v)}
                >
                  <IconX size={12} aria-hidden="true" />
                </button>
              </Chip>
            );
          })}
          <PopoverTrigger asChild>
            <button
              type="button"
              id={id}
              role="combobox"
              aria-expanded={open && !shut}
              aria-label={rest["aria-label"]}
              aria-busy={loading || undefined}
              disabled={shut}
              className={cn(
                "flex h-[28px] min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-[6px] bg-transparent px-1.5 text-left text-ink-ghost outline-none",
                "disabled:cursor-not-allowed",
                loading && "disabled:cursor-progress",
              )}
            >
              <span className="truncate">{loading ? <SkeletonText className="w-28" /> : value.length === 0 ? placeholder : ""}</span>
              <IconChevronDown size={15} className="shrink-0 text-ink-faint" aria-hidden="true" />
            </button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        <CommandPrimitive className="flex flex-col">
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {options.map((o) => (
              <CommandItem key={o.value} value={o.value} keywords={[o.label]} onSelect={() => toggle(o.value)}>
                <Checkbox checked={picked.has(o.value)} tabIndex={-1} aria-hidden="true" className="pointer-events-none" />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{o.hint}</span>}
              </CommandItem>
            ))}
          </CommandList>
        </CommandPrimitive>
      </PopoverContent>
    </Popover>
  );
}
