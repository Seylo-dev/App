import { expect, test } from "bun:test";
import { gitProviders, OpError } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../../i18n/t";
import { BranchSelect } from "./provider-form";

const input = { projectId: "prj1prj1prj1prj1", providerId: "gpr1gpr1gpr1gpr1", repo: "acme/shop" };

/** BranchSelect with gitProviders.branches already answered (or failed) in the cache. */
function render(answer: { branches: string[] } | OpError, value: string | null) {
  // retryOnMount: false keeps a failed query failed on render instead of fetching again.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const key = opQueryKey(gitProviders.branches, input);
  if (answer instanceof OpError) {
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: key })
      .setState({ status: "error", error: answer, fetchStatus: "idle", errorUpdateCount: 1, errorUpdatedAt: Date.now() });
  } else {
    queryClient.setQueryData(key, answer);
  }
  // No request leaves the test: the answer is in the cache already.
  const client = { call: () => new Promise(() => {}) } as unknown as OpClient;
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <OpClientProvider client={client}>
        <BranchSelect {...input} value={value} onChange={() => {}} />
      </OpClientProvider>
    </QueryClientProvider>,
  );
}

const html = (text: string) => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");
const failed = new OpError("FORBIDDEN", "GitLab answered 403: the token lacks the read_repository scope.");

test("a failed branch list says so and shows the provider's error, not 'Not available yet'", () => {
  // An empty repository: nothing to fall back on.
  const empty = render(failed, null);
  expect(empty).toContain(html(t("serviceSource.provider.branchesFailed")));
  expect(empty).toContain(html(failed.message));
  expect(empty).not.toContain(html(t("service.notBuilt.title")));
  expect(empty).toContain('disabled=""');

  // With the repository's default branch picked the list falls back to it (still pickable), and the error still shows.
  const withDefault = render(failed, "main");
  expect(withDefault).not.toContain('disabled=""');
  expect(withDefault).toContain(html(failed.message));
});

test("a loaded branch list shows no error, and an empty one says there are no branches", () => {
  const loaded = render({ branches: ["main", "dev"] }, null);
  expect(loaded).toContain(html(t("serviceSource.provider.pickBranch")));
  expect(loaded).not.toContain('role="alert"');
  expect(loaded).not.toContain(html(failed.message));
  expect(render({ branches: [] }, null)).toContain(html(t("serviceSource.provider.noBranches")));
});
