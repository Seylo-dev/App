// The search box of the Source tab's repository pickers (GitHub and the git
// providers). It opens on the repository the form holds, the service's own
// (owner/repo) when it has one, and shows whatever is picked after, until
// something is typed. Until then it searches nothing: the list shows every
// repository, with that one selected and scrolled into view inside the
// list. Focus selects the text, so the first key starts a new search.
// Opening it changes nothing in the form.

import { type ChangeEvent, type FocusEvent, type MouseEvent, type RefObject, useEffect, useRef, useState } from "react";

export function useRepoSearch(value: string | null) {
  // null until something is typed: the box shows the form's repository.
  const [typed, setTyped] = useState<string | null>(null);
  const edited = typed !== null;
  return {
    /** What to search for: nothing until the text is changed. */
    text: (typed ?? "").trim(),
    edited,
    input: {
      value: typed ?? value ?? "",
      onChange: (e: ChangeEvent<HTMLInputElement>) => setTyped(e.target.value),
      onFocus: (e: FocusEvent<HTMLInputElement>) => {
        if (!edited) e.currentTarget.select();
      },
      // A click would put the caret where it landed (some browsers undo a select on focus at mouseup): focus it here instead.
      onMouseDown: (e: MouseEvent<HTMLInputElement>) => {
        if (edited || !value || document.activeElement === e.currentTarget) return;
        e.preventDefault();
        e.currentTarget.focus();
      },
    },
  };
}

/** Where to scroll a list so a row shows whole in it, centered when it has to move; null when it shows already. */
export function scrollToShow(row: { top: number; height: number }, list: { scrollTop: number; height: number }): number | null {
  if (row.top >= list.scrollTop && row.top + row.height <= list.scrollTop + list.height) return null;
  return Math.max(0, Math.round(row.top - (list.height - row.height) / 2));
}

/**
 * A ref for a listbox whose selected option scrolls into view inside it once
 * `ready` (the list has loaded and nothing was typed), the first time only.
 * Only the list scrolls, never the page around it.
 */
export function useSelectedInView(ready: boolean): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !ready) return;
    done.current = true;
    const list = ref.current;
    const row = list?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (!list || !row) return;
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const to = scrollToShow({ top, height: row.offsetHeight }, { scrollTop: list.scrollTop, height: list.clientHeight });
    if (to !== null) list.scrollTop = to;
  }, [ready]);
  return ref;
}
