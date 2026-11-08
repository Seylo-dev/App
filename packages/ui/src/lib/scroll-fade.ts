// Rows that scroll sideways on narrow screens (the service tabs, the
// settings sections on a phone, the node sheet's views) hide their
// scrollbar with the `scroll-row` utility (styles/tailwind.css). Without a
// scrollbar nothing says more items are off to the side, so `scrollFadeRef`
// marks the edges that hide items (data-fade-start, data-fade-end) and the
// utility fades them out.

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

/**
 * A ref callback for a `scroll-row` element: keeps data-fade-start and
 * data-fade-end in step while the row scrolls, resizes or changes items.
 * Pass it as `ref={scrollFadeRef}`; React runs the cleanup it returns.
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
      : new MutationObserver(() => {
          watchItems();
          update();
        });
  watchItems();
  items?.observe(el, { childList: true });
  el.addEventListener("scroll", update, { passive: true });
  update();
  return () => {
    el.removeEventListener("scroll", update);
    resize?.disconnect();
    items?.disconnect();
  };
}
