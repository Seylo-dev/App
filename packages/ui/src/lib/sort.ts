// Sorting for DataTable, kept apart so it can be tested without a DOM.

export type SortValue = string | number | boolean | Date | null | undefined;

export interface SortState {
  id: string;
  desc: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Compares two sort values; empty values (null, undefined, "") sort last in both directions. */
export function compareValues(a: SortValue, b: SortValue, desc = false): number {
  const emptyA = a === null || a === undefined || a === "";
  const emptyB = b === null || b === undefined || b === "";
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  let r: number;
  if (typeof a === "string" && typeof b === "string") r = collator.compare(a, b);
  else {
    const na = a instanceof Date ? a.getTime() : Number(a);
    const nb = b instanceof Date ? b.getTime() : Number(b);
    r = na === nb ? 0 : na < nb ? -1 : 1;
  }
  return desc ? -r : r;
}

/** A sorted copy (stable: equal rows keep their order). */
export function sortRows<T>(rows: readonly T[], value: (row: T) => SortValue, desc: boolean): T[] {
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((x, y) => compareValues(x.v, y.v, desc) || x.i - y.i)
    .map((x) => x.row);
}

/** The next state when a header is clicked: ascending, then descending, then unsorted. */
export function nextSort(current: SortState | null, id: string): SortState | null {
  if (!current || current.id !== id) return { id, desc: false };
  if (!current.desc) return { id, desc: true };
  return null;
}
