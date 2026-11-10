// Starting a page's requests before it renders. Routes call these from
// their loader, which the router runs when a link to the page is hovered or
// focused (defaultPreload "intent") and again on navigation, before the page
// renders. Nothing is awaited by the navigation: the loader returns at once
// and the page's own useOp calls find the request already on its way (same
// query key), instead of starting it after their first render.
//
// Each input must be exactly the one the page's useOp passes, or the page
// asks again under its own key; pages export their inputs for that
// (for example `latestDeployInput`). A request already cached and fresh
// (the query client's staleTime) is not repeated, so hovering back and
// forth costs nothing.

import type { AnyOpContract, OpInput, OpOutput } from "@seylo/ops";
import { opQueryKey } from "@seylo/ops/react";
import type { RouterContext } from "./router-context";

type QueryOp = AnyOpContract & { readonly kind: "query" };

/**
 * Starts `op` with `input` unless the cache already has it fresh. Resolves
 * with the cached value afterwards (undefined when the request failed);
 * never rejects, so a loader can chain on it without a catch.
 */
export function prefetchOp<C extends QueryOp>(
  { queryClient, opClient }: RouterContext,
  op: C,
  input: OpInput<C>,
  /** The page's own staleTime when it sets one (an editor that keeps its first answer). */
  options: { staleTime?: number } = {},
): Promise<OpOutput<C> | undefined> {
  const queryKey = opQueryKey(op, input);
  return queryClient
    .prefetchQuery({ queryKey, queryFn: ({ signal }) => opClient.call(op, input, { signal }), ...options })
    .then(() => queryClient.getQueryData<OpOutput<C>>(queryKey))
    .catch(() => undefined);
}

/**
 * For a loader: runs `start` without making the navigation wait for it,
 * and without letting a failure in it reach the router (the page's own
 * queries show errors as they always do).
 */
export function startPrefetch(start: () => unknown): void {
  try {
    const result = start();
    if (result instanceof Promise) result.catch(() => {});
  } catch {
    // A prefetch is only a head start.
  }
}
