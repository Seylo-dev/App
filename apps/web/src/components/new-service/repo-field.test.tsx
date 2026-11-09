import { expect, test } from "bun:test";
import { github, gitProviders, OpError } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../i18n/t";
import { type RepoGroup, RepoList, RepoNote, useRepoSource } from "./repo-field";
import type { Connection, RepoDecision } from "./repo-source";

const projectId = "prj1prj1prj1prj1";
const acme: Connection = { kind: "github", id: "inst000000000001", label: "acme", baseUrl: "https://github.com", owner: "acme" };
const gitlab: Connection = { kind: "gitlab", id: "gp00000000000001", label: "Company GitLab", baseUrl: "https://gitlab.com", owner: null };

const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");

/** Renders inside a router (the empty state links to Settings) with a query cache the test fills. */
async function render(node: ReactNode, fill: (client: QueryClient) => void = () => {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  fill(queryClient);
  // No request leaves the test: answers are in the cache already, the rest stay pending.
  const client = { call: () => new Promise(() => {}) } as unknown as OpClient;
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
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

const list = (props: Partial<Parameters<typeof RepoList>[0]>) => (
  <RepoList
    projectId={projectId}
    listsPending={false}
    listsError={null}
    groups={[]}
    canManage
    query=""
    selected={null}
    onPick={() => {}}
    onMore={() => {}}
    {...props}
  />
);

const group = (connection: Connection, over: Partial<RepoGroup>): RepoGroup => ({
  connection,
  status: "ready",
  error: null,
  repos: [],
  hasMore: false,
  loadingMore: false,
  ...over,
});

test("nothing connected: owners and admins get the Settings links, members are told whom to ask", async () => {
  const admin = await render(list({}));
  expect(admin).toContain(t("newService.repo.noneTitle"));
  expect(admin).toContain('href="/settings/github"');
  expect(admin).toContain('href="/settings/git-providers"');

  const member = await render(list({ canManage: false }));
  expect(member).toContain(escaped(t("newService.repo.noneMember")));
  expect(member).not.toContain('href="/settings/github"');
});

test("loading shows skeleton rows, a failed load one calm line, and no project says to pick one", async () => {
  const loading = await render(list({ listsPending: true }));
  expect(loading).toContain('data-slot="skeleton"');
  expect(loading).toContain('aria-busy="true"');

  const failed = await render(list({ listsError: new OpError("UNAVAILABLE", "The panel is restarting.") }));
  expect(failed).toContain(t("newService.repo.loadFailed", { message: "The panel is restarting." }));
  expect(failed).not.toContain('data-slot="skeleton"');

  expect(await render(list({ projectId: "" }))).toContain(t("newService.repo.pickProject"));
});

test("repositories show by connection with private or public, and connections the person may not use drop out", async () => {
  const html = await render(
    list({
      groups: [
        group(acme, {
          repos: [
            { fullName: "acme/shop-api", private: true, defaultBranch: "main", updatedAt: null },
            { fullName: "acme/docs", private: false, defaultBranch: "main", updatedAt: null },
          ],
          hasMore: true,
        }),
        // FORBIDDEN: a GitLab connection not shared with this project.
        group(gitlab, { status: "hidden" }),
      ],
      selected: { connection: acme, repo: { fullName: "acme/docs", private: false, defaultBranch: "main", updatedAt: null } },
    }),
  );
  expect(html).toContain(escaped(t("newService.repo.group", { provider: "GitHub", name: "acme" })));
  expect(html).toContain("acme/shop-api");
  expect(html).toContain(t("newService.repo.private"));
  expect(html).toContain(t("newService.repo.public"));
  expect(html).toContain(t("newService.repo.more"));
  expect(html).toMatch(/aria-selected="true"[^>]*>.*?acme\/docs/);
  expect(html).not.toContain("Company GitLab");
});

test("a connection that is loading or failed says so in its own group; when none has a repository, one line", async () => {
  const html = await render(
    list({
      groups: [
        group(acme, { status: "loading" }),
        group(gitlab, { status: "error", error: new OpError("UNAVAILABLE", "GitLab answered 503.") }),
      ],
    }),
  );
  expect(html).toContain('data-slot="skeleton"');
  expect(html).toContain(t("newService.repo.groupFailed", { message: "GitLab answered 503." }));

  const none = await render(list({ groups: [group(acme, {}), group(gitlab, { status: "hidden" })] }));
  expect(none).toContain(t("newService.repo.noRepos"));
  const noMatch = await render(list({ groups: [group(acme, {})], query: "zzz" }));
  expect(noMatch).toContain(t("newService.repo.noMatch", { query: "zzz" }));
});

test("the line under the field says what the repository becomes", async () => {
  const note = async (text: string, decision: RepoDecision) => render(<RepoNote id="n" text={text} decision={decision} />);
  const ref = (url: string, host: string, path: string, ssh = false) => ({ url, host, path, ssh, branch: null });
  const repo = { fullName: "acme/shop-api", private: true, defaultBranch: "main", updatedAt: null };

  expect(await note("", { type: "none", problem: "empty" })).toContain(escaped(t("newService.repo.hint")));
  expect(await note("acme/shop-api", { type: "connected", found: { connection: acme, repo } })).toContain(
    "From your GitHub App (acme) - deploys on push",
  );
  expect(await note("x", { type: "connected", found: { connection: gitlab, repo } })).toContain(
    "From your GitLab connection Company GitLab - deploys on push",
  );
  expect(
    await note("acme/app", { type: "git", repo: ref("https://github.com/acme/app.git", "github.com", "acme/app"), missedIn: null }),
  ).toContain("Public GitHub repository github.com/acme/app");
  expect(
    await note("acme/app", { type: "git", repo: ref("https://github.com/acme/app.git", "github.com", "acme/app"), missedIn: acme }),
  ).toContain(escaped("your GitHub App (acme) cannot read it"));
  expect(
    await note("x", { type: "git", repo: ref("https://git.example.com/team/app.git", "git.example.com", "team/app"), missedIn: null }),
  ).toContain("Public git repository git.example.com/team/app");
  expect(
    await note("x", { type: "git", repo: ref("git@git.example.com:team/app.git", "git.example.com", "team/app", true), missedIn: null }),
  ).toContain("Cloned over SSH from git.example.com");
  const credentials = await note("https://a:b@x.dev/r", { type: "none", problem: "credentials" });
  expect(credentials).toContain("text-destructive");
  expect(await note("group/sub/repo", { type: "none", problem: "needsHost" })).toContain("gitlab.com/group/sub/repo");
});

/** The field's line for typed text, with what github.installations, gitProviders.list and github.repos answered in the cache. */
function Typed({ text }: { text: string }) {
  const source = useRepoSource({ projectId, text, picked: null, enabled: true });
  return <RepoNote id="n" text={text} decision={source.decision} />;
}

const installations = {
  installations: [
    {
      id: acme.id,
      installationId: 55501,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
      suspended: false,
      manageUrl: "https://github.com/organizations/acme/settings/installations/55501",
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ],
  installUrl: "https://github.com/apps/acme-seylo/installations/new",
  hidden: false,
};
const repos = (query: string, fullNames: string[]) => (client: QueryClient) =>
  client.setQueryData(opQueryKey(github.repos, { projectId, installationId: acme.id, query, page: 1 }), {
    repos: fullNames.map((fullName) => ({ fullName, private: true, defaultBranch: "main", pushedAt: null })),
    hasMore: false,
  });
const lists = (client: QueryClient) => {
  client.setQueryData(opQueryKey(github.installations, {}), installations);
  client.setQueryData(opQueryKey(gitProviders.list, {}), { items: [], hidden: false });
};

test("typed owner/repo the installation lists becomes the GitHub App source; one it does not list a public URL", async () => {
  const found = await render(<Typed text="acme/shop-api" />, (client) => {
    lists(client);
    repos("acme/shop-api", ["acme/shop-api"])(client);
  });
  expect(found).toContain("From your GitHub App (acme) - deploys on push");

  const missed = await render(<Typed text="acme/secret" />, (client) => {
    lists(client);
    repos("acme/secret", ["acme/secret-sauce"])(client);
  });
  expect(missed).toContain(escaped("Public GitHub repository github.com/acme/secret - your GitHub App (acme) cannot read it"));

  // While the installation has not answered: checking, so Create waits.
  const checking = await render(<Typed text="acme/shop-api" />, lists);
  expect(checking).toContain(t("newService.repo.checking", { path: "acme/shop-api" }));

  // Another account: no lookup at all.
  expect(await render(<Typed text="torvalds/linux" />, lists)).toContain("Public GitHub repository github.com/torvalds/linux");
});

test("while the connection lists load, a typed repository is checking", async () => {
  expect(await render(<Typed text="https://git.example.com/team/app.git" />)).toContain(
    t("newService.repo.checking", { path: "team/app" }),
  );
});
