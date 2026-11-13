// The panel's table: a white card with quiet column headers, divider rows,
// click-to-sort columns, an empty state and a row-actions menu, which is
// also the row's right-click menu (the same entries, menu-items.tsx). Rows
// come in already loaded (screens page with ops); sorting is client-side.

import { IconArrowDown, IconArrowUp, IconDots, IconSelector } from "@tabler/icons-react";
import { type ReactNode, useMemo, useState } from "react";
import { nextSort, type SortState, type SortValue, sortRows } from "../lib/sort";
import { cn } from "../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu";
import { EmptyState } from "./empty-state";
import { useUiLabels } from "./labels";
import { type MenuEntry, MenuItems, RowContextMenu } from "./menu-items";
import { SkeletonText } from "./skeleton";

export type { SortState } from "../lib/sort";

export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Makes the column sortable by this value. */
  sortValue?: (row: T) => SortValue;
  align?: "left" | "right";
  /** Width like "120px" or "30%"; omit to share the rest. */
  width?: string;
  /**
   * The width this column usually ends up with once rows are in, like "18%"
   * (of the table) or "140px". Only the loading placeholder cells take it,
   * so the header stays where it is when the rows arrive. Give it to every
   * column but one and those with a `width`: that one takes the rest, as it
   * does with real rows.
   */
  skeletonWidth?: string;
  /** 2 when the cells show a 13px line over a 12px detail line (a name and its email), so placeholder rows are as tall. */
  skeletonLines?: 1 | 2;
  className?: string;
  /** Hide the column under the md breakpoint. */
  hideOnMobile?: boolean;
}

/**
 * The `width` of a column of relative times ("12 minutes ago", "in 10
 * months", a date): the longest of them fits, and the column keeps it
 * whatever the rows say. Sized to its text, such a column moved the others
 * as the clock went on ("3 minutes ago" to "12 minutes ago" moved People's
 * header 5.6px), so no loading placeholder could hold the header in place.
 */
export const timeColumnWidth = "130px";

export interface RowAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Why it is disabled, shown in the menu. */
  disabledReason?: string;
  /** Draw a separator above this action. */
  separated?: boolean;
}

/** A row's actions as menu entries: the "..." menu and the right-click menu both show these. */
export function rowActionEntries(actions: readonly RowAction[]): MenuEntry[] {
  return actions.flatMap((action): MenuEntry[] => [
    ...(action.separated ? [{ type: "separator", id: `${action.label}:separator` } as const] : []),
    {
      type: "item",
      id: action.label,
      label: action.label,
      icon: action.icon,
      onSelect: action.onSelect,
      destructive: action.destructive,
      disabled: action.disabled,
      disabledReason: action.disabledReason,
    },
  ]);
}

export interface DataTableProps<T> {
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  getRowId: (row: T) => string;
  /** Accessible name of the table, for example "Node list". */
  "aria-label": string;
  /** Uncontrolled initial sort. */
  initialSort?: SortState | null;
  /** Controlled sort. */
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  /** Items for the "..." menu at the end of each row, and its right-click menu. */
  rowActions?: (row: T) => RowAction[];
  onRowClick?: (row: T) => void;
  /** Shown instead of rows when there are none (an EmptyState). */
  empty?: ReactNode;
  /** Skeleton rows while the first page loads. */
  loading?: boolean;
  /** How many skeleton rows: about as many as the first page usually has. Default 3. */
  skeletonRows?: number;
  /** Below this width the table scrolls sideways instead of squeezing. */
  minWidth?: number;
  /** No card around it (when it sits inside a SectionCard). */
  bare?: boolean;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  initialSort = null,
  sort: sortProp,
  onSortChange,
  rowActions,
  onRowClick,
  empty,
  loading = false,
  skeletonRows = 3,
  minWidth,
  bare = false,
  className,
  ...rest
}: DataTableProps<T>) {
  const labels = useUiLabels();
  const [sortState, setSortState] = useState<SortState | null>(initialSort);
  const sort = sortProp === undefined ? sortState : sortProp;

  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.id === sort.id);
    return col?.sortValue && sort ? sortRows(rows, col.sortValue, sort.desc) : rows;
  }, [rows, columns, sort]);

  function toggleSort(id: string) {
    const next = nextSort(sort, id);
    if (sortProp === undefined) setSortState(next);
    onSortChange?.(next);
  }

  const colCount = columns.length + (rowActions ? 1 : 0);
  const pad = (i: number, last: boolean) => cn(i === 0 ? "pl-[18px]" : "pl-2.5", last ? "pr-[18px]" : "pr-2.5");

  return (
    <div data-slot="data-table" className={cn("relative min-w-0 overflow-x-auto", !bare && "rounded-card bg-card shadow-card", className)}>
      <table
        className="w-full border-collapse text-[13px]"
        // No minimum width while the empty state shows: it centers on the table, and a table wider
        // than a phone put it off center with its description cut off at the card's edge.
        style={minWidth && (loading || rows.length > 0) ? { minWidth } : undefined}
        aria-label={rest["aria-label"]}
        aria-busy={loading}
      >
        <thead>
          <tr className="text-left text-[12px] text-muted-foreground">
            {columns.map((col, i) => {
              const active = sort?.id === col.id;
              const ariaSort = active ? (sort?.desc ? "descending" : "ascending") : col.sortValue ? "none" : undefined;
              return (
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={ariaSort}
                  style={col.width ? { width: col.width } : undefined}
                  className={cn(
                    "border-b border-divider pt-3.5 pb-3 font-medium whitespace-nowrap",
                    pad(i, i === colCount - 1),
                    col.align === "right" && "text-right",
                    col.hideOnMobile && "max-md:hidden",
                  )}
                >
                  {col.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.id)}
                      title={active && !sort?.desc ? labels.sortDescending : labels.sortAscending}
                      className={cn(
                        "inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-medium text-inherit transition-interactive hover:text-foreground",
                        active && "text-foreground",
                        col.align === "right" && "flex-row-reverse",
                      )}
                    >
                      {col.header}
                      {active ? (
                        sort?.desc ? (
                          <IconArrowDown size={13} stroke={2} />
                        ) : (
                          <IconArrowUp size={13} stroke={2} />
                        )
                      ) : (
                        <IconSelector size={13} className="text-ink-ghost" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
            {rowActions && (
              <th scope="col" className="w-12 border-b border-divider pr-[18px]">
                <span className="sr-only">{labels.actions}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {loading &&
            rows.length === 0 &&
            Array.from({ length: skeletonRows }, (_, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows.
              <tr key={`skeleton-${n}`}>
                {columns.map((col, i) => (
                  <td
                    key={col.id}
                    style={col.skeletonWidth ? { width: col.skeletonWidth } : undefined}
                    className={cn(
                      "border-t border-divider py-3.5",
                      pad(i, i === colCount - 1),
                      col.hideOnMobile && "max-md:hidden",
                      col.className,
                    )}
                  >
                    {/* The row's 13px line (and the 12px detail line), so the row is as tall as a loaded one. */}
                    <SkeletonText className={cn("w-3/4", col.align === "right" && "ml-auto")} />
                    {col.skeletonLines === 2 && <SkeletonText className={cn("w-1/2 text-xs", col.align === "right" && "ml-auto")} />}
                  </td>
                ))}
                {rowActions && <td className="border-t border-divider" />}
              </tr>
            ))}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={colCount}>{empty ?? <EmptyState compact title={labels.noRows} />}</td>
            </tr>
          )}
          {sorted.map((row) => {
            const actions = rowActions?.(row);
            const entries = actions ? rowActionEntries(actions) : [];
            return (
              <RowContextMenu key={getRowId(row)} entries={entries} aria-label={labels.rowActions}>
                <tr
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "align-middle transition-colors duration-200 data-[state=open]:bg-raised",
                    onRowClick && "cursor-pointer hover:bg-raised",
                  )}
                >
                  {columns.map((col, i) => (
                    <td
                      key={col.id}
                      className={cn(
                        "border-t border-divider py-3.5",
                        pad(i, i === colCount - 1),
                        col.align === "right" && "text-right tabular-nums",
                        col.hideOnMobile && "max-md:hidden",
                        col.className,
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                  {actions && actions.length === 0 && <td className="border-t border-divider" />}
                  {actions && actions.length > 0 && (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: only stops the row click; the menu button handles keys.
                    <td className="border-t border-divider py-2 pr-[18px] text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          aria-label={labels.rowActions}
                          className="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent text-ink-faint transition-interactive hover:bg-muted hover:text-foreground data-[state=open]:bg-muted"
                        >
                          <IconDots size={16} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <MenuItems as="dropdown" entries={entries} />
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  )}
                </tr>
              </RowContextMenu>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
