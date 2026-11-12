import { expect, test } from "bun:test";
import { gitProviders, OpError } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../../i18n/t";
import { renderStatic } from "../../../test/render";
import type { ServiceDetail } from "../use-service";
import { BranchSelect, ProviderForm } from "./provider-form";

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

const gitlab = { id: "gpr1gpr1gpr1gpr1", kind: "gitlab", name: "Company GitLab", host: "gitlab.com", workspace: null };
const withSource = (repo: string | null) =>
  ({
    id: "svc-1",
    projectId: "prj1prj1prj1prj1",
    sourceConfig: repo
      ? { type: "provider", providerId: gitlab.id, provider: "gitlab", repo, branch: "main", deployOnPush: true }
      : { type: "none" },
  }) as unknown as ServiceDetail;
const row = (fullName: string) => ({ fullName, private: false, defaultBranch: "main", updatedAt: null });

/** ProviderForm with the connection and the first page of repositories (no search) in the cache. */
function renderForm(service: ServiceDetail, repos: string[]) {
  return renderStatic(
    () => <ProviderForm service={service} kind="gitlab" />,
    [
      [gitProviders.list, {}, { items: [gitlab], hidden: false }],
      [gitProviders.repos, { projectId: service.projectId, providerId: gitlab.id, page: 1 }, { repos: repos.map(row), hasMore: false }],
    ],
  );
}

const searchBox = (out: string) =>
  new RegExp(`<input[^>]*aria-label="${t("serviceSource.provider.searchRepos")}"[^>]*>`).exec(out)?.[0] ?? "";
const options = (out: string) =>
  [...out.matchAll(/<button[^>]*role="option" aria-selected="(true|false)"[^>]*>.*?<span[^>]*>([^<]+)<\/span>/g)].map(
    (m) => `${m[2]}${m[1] === "true" ? " (selected)" : ""}`,
  );

test("the provider picker opens on the service's repository, selected in the full list", async () => {
  const out = await renderForm(withSource("acme/platform/shop"), ["acme/site", "acme/platform/shop"]);
  expect(searchBox(out)).toContain('value="acme/platform/shop"');
  // The text is no search: GitLab would not find a full path, so the list stays whole.
  expect(options(out)).toEqual(["acme/site", "acme/platform/shop (selected)"]);
  expect(out).toContain(t("serviceSource.provider.isConnected"));

  // Not on the first page: first, selected.
  expect(options(await renderForm(withSource("acme/old"), ["acme/site"]))).toEqual(["acme/old (selected)", "acme/site"]);
});

test("a service with no provider source opens the picker empty", async () => {
  const out = await renderForm(withSource(null), ["acme/site", "acme/platform/shop"]);
  expect(searchBox(out)).toContain('value=""');
  expect(options(out)).toEqual(["acme/site", "acme/platform/shop"]);
});
