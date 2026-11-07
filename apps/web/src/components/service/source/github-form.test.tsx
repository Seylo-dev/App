import { expect, test } from "bun:test";
import { github } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../../i18n/t";
import type { ServiceDetail } from "../use-service";
import { GithubForm } from "./github-form";

// Only what GithubForm reads.
const service = {
  id: "svc-1",
  projectId: "prj-1",
  build: { contextPath: "" },
  sourceConfig: { type: "github", installationId: "inst-1", repo: "acme/shop", branch: "main", deployOnPush: true },
} as unknown as ServiceDetail;

async function render(installations: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  queryClient.setQueryData(opQueryKey(github.installations, {}), installations);
  // No request leaves the test: the answer is in the cache already.
  const client = { call: () => new Promise(() => {}) } as unknown as OpClient;
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <GithubForm service={service} /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <OpClientProvider client={client}>
        <RouterProvider router={router} />
      </OpClientProvider>
    </QueryClientProvider>,
  );
}

test("someone who may not see the App sees the connected repository read-only, not a missing App", async () => {
  // What github.installations answers a member with only services.view.
  const html = await render({ installations: [], installUrl: null, hidden: true });
  expect(html).toContain('readOnly="" value="acme/shop"');
  expect(html).toContain('readOnly="" value="main"');
  expect(html).toContain(t("serviceSource.github.readOnly"));
  // Before: "Connect GitHub first" and a set-up link, although the service is connected through the App.
  expect(html).not.toContain(t("serviceSource.github.noAppTitle"));
  expect(html).not.toContain(t("serviceSource.github.connect"));
});

test("someone who may see the App but has no installation still gets the install callout", async () => {
  const html = await render({ installations: [], installUrl: "https://github.com/apps/acme-seylo/installations/new", hidden: false });
  expect(html).toContain(t("serviceSource.github.noAppTitle"));
  expect(html).toContain("https://github.com/apps/acme-seylo/installations/new");
  expect(html).not.toContain(t("serviceSource.github.readOnly"));
});
