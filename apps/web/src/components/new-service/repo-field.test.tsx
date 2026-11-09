import { expect, test } from "bun:test";
import { auth, github, gitProviders, grants, OpError } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
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
  // retryOnMount off: a failure put in the cache stays one instead of being asked again as the field mounts.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } },
  });
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

/** A query that failed with `error`, as the cache keeps it. */
const failedQuery = (client: QueryClient, queryKey: QueryKey, error: OpError) =>
  client
    .getQueryCache()
    .build(client, { queryKey })
    .setState({ status: "error", error, fetchStatus: "idle", errorUpdateCount: 1, errorUpdatedAt: Date.now() });

const noListErrors = { github: null, providers: null };

const list = (props: Partial<Parameters<typeof RepoList>[0]>) => (
  <RepoList
    projectId={projectId}
    listsPending={false}
    listErrors={noListErrors}
    canConnect
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

  const down = new OpError("UNAVAILABLE", "The panel is restarting.");
  const failed = await render(list({ listErrors: { github: down, providers: down } }));
  expect(failed).toContain(t("newService.repo.loadFailed", { message: "The panel is restarting." }));
  expect(failed).not.toContain('data-slot="skeleton"');

  expect(await render(list({ projectId: "" }))).toContain(t("newService.repo.pickProject"));
});

test("one list failing says so above the other's repositories, and is never 'nothing connected'", async () => {
  const down = new OpError("UNAVAILABLE", "The panel is restarting.");
  const html = await render(
    list({
      listErrors: { github: down, providers: null },
      groups: [group(gitlab, { repos: [{ fullName: "acme/site", private: false, defaultBranch: "trunk", updatedAt: null }] })],
    }),
  );
  expect(html).toContain(t("newService.repo.listFailed.github", { message: "The panel is restarting." }));
  expect(html).toContain("acme/site");

  // Only the GitHub list failed and there is no provider: not the "connect one" state with its Set up GitHub link.
  const alone = await render(list({ listErrors: { github: down, providers: null }, groups: [] }));
  expect(alone).toContain(t("newService.repo.listFailed.github", { message: "The panel is restarting." }));
  expect(alone).not.toContain(t("newService.repo.noneTitle"));
  expect(alone).not.toContain('href="/settings/github"');
});

test("someone who may create but not change services is told why there is nothing to pick", async () => {
  const html = await render(list({ canConnect: false, groups: [group(acme, { status: "loading" })] }));
  expect(html).toContain(escaped(t("newService.repo.cannotConnect")));
  expect(html).not.toContain('role="option"');
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

test("Show more stays while the next page loads, so the focus has somewhere to stay", async () => {
  const repos = [{ fullName: "acme/shop-api", private: true, defaultBranch: "main", updatedAt: null }];
  const html = await render(list({ groups: [group(acme, { repos, hasMore: true, loadingMore: true })] }));
  expect(html).toContain('data-slot="skeleton"');
  expect(html).toMatch(
    /<button[^>]*aria-disabled="true"[^>]*data-more="inst000000000001"|data-more="inst000000000001"[^>]*aria-disabled="true"/,
  );
  expect(html).toContain(t("newService.repo.more"));
});

test("a next page that failed says so under the rows, and Show more stays to ask again", async () => {
  const repos = [{ fullName: "acme/shop-api", private: true, defaultBranch: "main", updatedAt: null }];
  const moreError = new OpError("UNAVAILABLE", "GitHub answered 502.");
  const html = await render(list({ groups: [group(acme, { repos, hasMore: true, moreError })] }));
  expect(html).toContain("acme/shop-api");
  expect(html).toContain(t("newService.repo.groupFailed", { message: "GitHub answered 502." }));
  expect(html).toContain(t("newService.repo.more"));
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
  const note = async (text: string, decision: RepoDecision, onRetry?: () => void) =>
    render(<RepoNote id="n" text={text} decision={decision} onRetry={onRetry} />);
  const ref = (url: string, host: string, path: string, ssh = false) => ({ url, host, path, ssh, ref: null });
  const repo = { fullName: "acme/shop-api", private: true, defaultBranch: "main", updatedAt: null };
  const githubRef = ref("https://github.com/acme/app.git", "github.com", "acme/app");

  expect(await note("", { type: "none", problem: "empty" })).toContain(escaped(t("newService.repo.hint")));
  expect(await note("acme/shop-api", { type: "connected", found: { connection: acme, repo } })).toContain(
    "From your GitHub App (acme) - deploys on push",
  );
  expect(await note("x", { type: "connected", found: { connection: gitlab, repo } })).toContain(
    "From Company GitLab (GitLab) - deploys on push",
  );
  expect(await note("acme/app", { type: "git", repo: githubRef, missedIn: null })).toContain(
    "Public GitHub repository github.com/acme/app",
  );
  // Not "public ... cannot read it": what happens, and what to do if it is private.
  const missed = await note("acme/app", { type: "git", repo: githubRef, missedIn: acme });
  expect(missed).toContain(escaped("Not in your GitHub App (acme) - cloned as public. Private? Give the App access first."));
  expect(missed).not.toContain("Public GitHub repository");
  const gitlabRef = ref("https://gitlab.com/acme/x.git", "gitlab.com", "acme/x");
  expect(await note("x", { type: "git", repo: gitlabRef, missedIn: gitlab })).toContain(
    "Not in Company GitLab (GitLab) - cloned as public.",
  );
  expect(
    await note("x", { type: "git", repo: ref("https://git.example.com/team/app.git", "git.example.com", "team/app"), missedIn: null }),
  ).toContain("Public git repository git.example.com/team/app");
  expect(
    await note("x", { type: "git", repo: ref("git@git.example.com:team/app.git", "git.example.com", "team/app", true), missedIn: null }),
  ).toContain("Cloned over SSH from git.example.com: add a deploy key on the Source tab, then deploy.");
  const credentials = await note("https://a:b@x.dev/r", { type: "none", problem: "credentials" });
  expect(credentials).toContain("text-destructive");
  expect(credentials).toContain("Remove the token from the URL - add it as a git credential on the Source tab after creating.");
  expect(await note("group/sub/repo", { type: "none", problem: "needsHost" })).toContain("gitlab.com/group/sub/repo");

  // A connection that did not answer: what failed, and Try again.
  const error = new OpError("UNAVAILABLE", "GitLab answered 502.");
  const unchecked = await note("x", { type: "unchecked", repo: gitlabRef, failed: gitlab, error }, () => {});
  expect(unchecked).toContain("Could not check Company GitLab (GitLab). GitLab answered 502.");
  expect(unchecked).toMatch(/<button[^>]*>Try again<\/button>/);
  expect(await note("x", { type: "unchecked", repo: githubRef, failed: acme, error }, () => {})).toContain(
    "Could not check your GitHub App (acme). GitLab answered 502.",
  );
  expect(await note("x", { type: "unchecked", repo: githubRef, failed: "github", error }, () => {})).toContain(
    "Could not load your GitHub App installations. GitLab answered 502.",
  );
  expect(await note("x", { type: "checking", repo: githubRef, needsProject: true })).toContain(
    "Pick a project to look for acme/app in your connections.",
  );
});

/** The field's line for typed text, with what github.installations, gitProviders.list and the lookups answered in the cache. */
function Typed({ text }: { text: string }) {
  const source = useRepoSource({ projectId, text, picked: null, enabled: true });
  return <RepoNote id="n" text={text} decision={source.decision} onRetry={source.retry} />;
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
const gitlabRow = { id: gitlab.id, kind: "gitlab", name: "Company GitLab", url: "https://gitlab.com", workspace: null };
const viewer = (role: string) => ({ viewer: { id: "user000000000001", email: "you@example.com", name: "", role }, via: "session" });
const branchesKey = (repo: string) => opQueryKey(github.branches, { projectId, installationId: acme.id, repo });
/** The installation reads the repository: github.branches answered. */
const reads =
  (repo: string, defaultBranch = "main") =>
  (client: QueryClient) =>
    client.setQueryData(branchesKey(repo), { branches: [defaultBranch], defaultBranch });
const lists = (client: QueryClient) => {
  client.setQueryData(opQueryKey(auth.whoami, {}), viewer("owner"));
  client.setQueryData(opQueryKey(github.installations, {}), installations);
  client.setQueryData(opQueryKey(gitProviders.list, {}), { items: [gitlabRow], hidden: false });
};

test("typed owner/repo the installation reads becomes the GitHub App source; one it cannot read a public URL that says so", async () => {
  const found = await render(<Typed text="acme/shop-api" />, (client) => {
    lists(client);
    reads("acme/shop-api")(client);
  });
  expect(found).toContain("From your GitHub App (acme) - deploys on push");

  const missed = await render(<Typed text="acme/secret" />, (client) => {
    lists(client);
    failedQuery(client, branchesKey("acme/secret"), new OpError("NOT_FOUND", "The App cannot read acme/secret.", { field: "repo" }));
  });
  expect(missed).toContain(escaped("Not in your GitHub App (acme) - cloned as public."));

  // While the installation has not answered: checking, so Create waits.
  const checking = await render(<Typed text="acme/shop-api" />, lists);
  expect(checking).toContain(t("newService.repo.checking", { path: "acme/shop-api" }));

  // Another account: no lookup at all.
  expect(await render(<Typed text="torvalds/linux" />, lists)).toContain("Public GitHub repository github.com/torvalds/linux");
});

test("the typed repository is looked up by its exact name, so neither a long search nor a Bitbucket display name hides it", async () => {
  // gitlab.com/acme/api: gitProviders.branches for acme/api itself, whatever else matches "api".
  const html = await render(<Typed text="https://gitlab.com/acme/api.git" />, (client) => {
    lists(client);
    client.setQueryData(opQueryKey(gitProviders.branches, { projectId, providerId: gitlab.id, repo: "acme/api" }), {
      branches: ["main"],
      defaultBranch: "main",
    });
  });
  expect(html).toContain("From Company GitLab (GitLab) - deploys on push");
});

test("a lookup or a list that failed leaves the field unchecked with Try again, never a public URL", async () => {
  // GitLab down for gitlab.com/acme/private-api.
  const down = await render(<Typed text="gitlab.com/acme/private-api" />, (client) => {
    lists(client);
    failedQuery(
      client,
      opQueryKey(gitProviders.branches, { projectId, providerId: gitlab.id, repo: "acme/private-api" }),
      new OpError("UNAVAILABLE", "GitLab did not answer."),
    );
  });
  expect(down).toContain("Could not check Company GitLab (GitLab). GitLab did not answer.");
  expect(down).toContain(t("newService.repo.retry"));
  expect(down).not.toContain("Public git repository");

  // Only github.installations failed: a github.com repository cannot be checked.
  const noInstallations = await render(<Typed text="acme/private" />, (client) => {
    client.setQueryData(opQueryKey(auth.whoami, {}), viewer("owner"));
    client.setQueryData(opQueryKey(gitProviders.list, {}), { items: [], hidden: false });
    failedQuery(client, opQueryKey(github.installations, {}), new OpError("UNAVAILABLE", "The panel is restarting."));
  });
  expect(noInstallations).toContain("Could not load your GitHub App installations. The panel is restarting.");
  expect(noInstallations).not.toContain("Public GitHub repository");
});

test("a member without services.update gets plain git URLs: no lookup that would end in a half-made app", async () => {
  const html = await render(<Typed text="acme/shop-api" />, (client) => {
    lists(client);
    client.setQueryData(opQueryKey(auth.whoami, {}), viewer("member"));
    client.setQueryData(opQueryKey(grants.mine, {}), {
      grants: [
        {
          id: "grant00000000001",
          userId: "user000000000001",
          scopeType: "project",
          scopeId: projectId,
          scopeName: "shop",
          projectId: null,
          actions: ["services.create", "services.deploy"],
          createdBy: null,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    reads("acme/shop-api")(client);
  });
  expect(html).toContain("Public GitHub repository github.com/acme/shop-api");
});

test("while the connection lists load, a typed repository is checking", async () => {
  expect(await render(<Typed text="https://git.example.com/team/app.git" />)).toContain(
    t("newService.repo.checking", { path: "team/app" }),
  );
});
