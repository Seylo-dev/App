// Whether a table fits the card it sits in, for lists that turn into
// stacked rows on narrow screens (the node list, the dashboard's service
// table) instead of cutting text or scrolling columns out of view.

import { useCallback, useMemo, useRef, useState } from "react";

type RefCallback<T> = (el: T | null) => (() => void) | undefined;

/**
 * Whether the table fits the list: the list is at least `min` px wide and
 * the table, once drawn, is no wider than the list (its cells keep long
 * values on one line). A table that does not fit records the width it
 * needs, so the list stays stacked until it is that wide. Both ref
 * callbacks measure before the first paint, so the list never flashes the
 * other layout, and again as either resizes.
 */
export function useTableFits(min: number): [RefCallback<HTMLElement>, RefCallback<HTMLTableElement>, boolean] {
  const section = useRef<HTMLElement | null>(null);
  const table = useRef<HTMLTableElement | null>(null);
  const [size, setSize] = useState({ width: Number.POSITIVE_INFINITY, need: min });
  const check = useCallback(() => {
    const el = section.current;
    if (!el) return;
    const width = el.clientWidth;
    const drawn = table.current?.offsetWidth ?? 0;
    setSize((s) => {
      const need = drawn > width + 1 ? Math.max(s.need, Math.ceil(drawn)) : s.need;
      return s.width === width && s.need === need ? s : { width, need };
    });
  }, []);
  const observe = useCallback(
    <T extends HTMLElement>(holder: { current: T | null }) =>
      (el: T | null) => {
        holder.current = el;
        if (!el) return undefined;
        check();
        if (typeof ResizeObserver === "undefined") return undefined;
        const observer = new ResizeObserver(check);
        observer.observe(el);
        return () => {
          observer.disconnect();
          if (holder.current === el) holder.current = null;
        };
      },
    [check],
  );
  const sectionRef = useMemo(() => observe(section), [observe]);
  const tableRef = useMemo(() => observe(table), [observe]);
  return [sectionRef, tableRef, size.width >= size.need];
}
