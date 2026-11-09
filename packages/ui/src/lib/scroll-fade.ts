// Rows that scroll sideways when they do not fit (tab bars, the settings
// sections on a phone, segmented tracks such as the node sheet's views)
// hide their scrollbar with the `scroll-row` utility (styles/tailwind.css).
// Without a scrollbar nothing says more items are off to the side, so
// `scrollFadeRef` marks the edges that hide items (data-fade-start,
// data-fade-end) and the utility fades them out. It also keeps the current
// item (the active tab, the selected option) in the visible part of the
// row, so a row opened on a later tab never hides which one is selected.

import { type Ref, useCallback } from "react";

export interface ScrollBox {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

/** Which edges of a row hide items. A pixel of slack absorbs subpixel widths. */
export function scrollFadeEdges(box: ScrollBox): { start: boolean; end: boolean } {
  const hidden = box.scrollWidth - box.clientWidth;
  if (hidden <= 1) return { start: false, end: false };
  // Right-to-left rows count scrollLeft down from 0.
  const scrolled = Math.abs(box.scrollLeft);
  return { start: scrolled > 1, end: scrolled < hidden - 1 };
}

/** What marks the current item of a row: a router link, a tab, a segmented option, a pressed filter. */
export const currentItemSelector =
  '[aria-current="page"], [data-status="active"], [aria-selected="true"], [data-state="on"], [aria-pressed="true"]';

/** How far the current item should stay from an edge: the width of the fade. */
const edgeRoom = 32;

/**
 * How far a row must scroll (negative: back toward the start) so that an
 * item sits inside it, clear of the faded edges. 0 when it already does.
 * Takes the boxes in viewport coordinates (getBoundingClientRect).
 */
export function revealDelta(row: { left: number; right: number }, item: { left: number; right: number }): number {
  if (item.left < row.left + edgeRoom) return item.left - row.left - edgeRoom;
  if (item.right > row.right - edgeRoom) return item.right - row.right + edgeRoom;
  return 0;
}

/** Scrolls the row, never the page, so its current item shows. */
export function revealCurrent(el: HTMLElement, smooth = false): void {
  if (el.scrollWidth - el.clientWidth <= 1) return;
  const item = el.querySelector<HTMLElement>(currentItemSelector);
  if (!item) return;
  const delta = revealDelta(el.getBoundingClientRect(), item.getBoundingClientRect());
  if (Math.abs(delta) < 1) return;
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollBy({ left: delta, behavior: smooth && !reduced ? "smooth" : "auto" });
}

/**
 * A ref callback for a `scroll-row` element: keeps data-fade-start and
 * data-fade-end in step while the row scrolls, resizes or changes items,
 * and scrolls the current item into view when the row mounts and when the
 * current item changes. Pass it as `ref={scrollFadeRef}`; React runs the
 * cleanup it returns. The kit's TabList and Segmented use it already.
 */
export function scrollFadeRef(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  const update = () => {
    const { start, end } = scrollFadeEdges(el);
    el.toggleAttribute("data-fade-start", start);
    el.toggleAttribute("data-fade-end", end);
  };
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
  const watchItems = () => {
    if (!resize) return;
    resize.disconnect();
    resize.observe(el);
    // An item that grows (a label loading in) widens the row without resizing it.
    for (const child of el.children) resize.observe(child);
  };
  const items =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          // Items added or removed (the row's own children), not text changing inside an item.
          const added = records.some((r) => r.type === "childList" && r.target === el);
          // Only an item that became current moves the row; other attribute changes (a tooltip opening) leave it.
          const moved = records.some(
            (r) => r.type === "attributes" && r.target instanceof Element && r.target.matches(currentItemSelector),
          );
          if (added) watchItems();
          update();
          if (added || moved) revealCurrent(el, moved);
        });
  watchItems();
  items?.observe(el, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-current", "data-status", "aria-selected", "data-state", "aria-pressed"],
  });
  el.addEventListener("scroll", update, { passive: true });
  update();
  revealCurrent(el);
  // Once more after the first layout (fonts, labels that load in).
  const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => revealCurrent(el)) : 0;
  return () => {
    if (frame) cancelAnimationFrame(frame);
    el.removeEventListener("scroll", update);
    resize?.disconnect();
    items?.disconnect();
  };
}

/**
 * scrollFadeRef for a component that also forwards its element to a ref the
 * caller passed (TabList, Segmented). Stable while `forward` is.
 */
export function useScrollFadeRef<T extends HTMLElement>(forward?: Ref<T>): (el: T | null) => () => void {
  return useCallback(
    (el: T | null) => {
      const stop = scrollFadeRef(el);
      let release: (() => void) | undefined;
      if (typeof forward === "function") {
        const cleanup = forward(el);
        release = typeof cleanup === "function" ? cleanup : () => forward(null);
      } else if (forward) {
        forward.current = el;
        release = () => {
          forward.current = null;
        };
      }
      return () => {
        stop?.();
        release?.();
      };
    },
    [forward],
  );
}
