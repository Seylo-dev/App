// Static rendering for component tests: a query cache holding the answers a
// screen reads (any op left out stays pending, the way it looks while the
// panel has not answered), an op client that never answers, the kit's
// words, and a router around the screen so its links render. `path` opens
// the screen on another page; a project page (/p/<id>) or a service page
// (/p/<id>/s/<id>) gives it the ids the way the app's routes do (useParams).
// `errors` are queries that failed (a permission the viewer lacks).

import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { UiLabelsProvider } from "@seylo/ui/components/labels";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { uiLabels } from "../lib/ui-labels";

/** One cached answer: the op, its input and what it returned. */
export type Answer = [op: Parameters<typeof opQueryKey>[0], input: unknown, data: unknown];

/** One refused query: the op, its input and the error it failed with. */
export type Refusal = [op: Parameters<typeof opQueryKey>[0], input: unknown, error: Error];

export async function renderStatic(
  screen: () => ReactNode,
  answers: Answer[] = [],
  options: { path?: string; errors?: Refusal[] } = {},
): Promise<string> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  for (const [op, input, data] of answers) queryClient.setQueryData(opQueryKey(op, input), data);
  for (const [op, input, error] of options.errors ?? []) {
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: opQueryKey(op, input) })
      .setState({ status: "error", fetchStatus: "idle", error });
  }
  // No request leaves the test: what is not in the cache stays pending.
  const client = { call: () => new Promise(() => {}) } as unknown as OpClient;
  const root = createRootRoute({ component: screen });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/p/$projectId", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/p/$projectId/s/$serviceId", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: [options.path ?? "/"] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <UiLabelsProvider labels={uiLabels()}>
      <QueryClientProvider client={queryClient}>
        <OpClientProvider client={client}>
          <RouterProvider router={router} />
        </OpClientProvider>
      </QueryClientProvider>
    </UiLabelsProvider>,
  );
}
