import { expect, test } from "bun:test";
import { auth, github, grants, OpError } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../i18n/t";
import { GithubSetup } from "./github-setup";
import { githubParse, type RepoGroup, RepoList, RepoNote, useRepoSource } from "./repo-field";
import type { Connection, RepoDecision } from "./repo-source";

const projectId = "prj1prj1prj1prj1";
const acme: Connection = { kind: "github", id: "inst000000000001", label: "acme", baseUrl: "https://github.com", owner: "acme" };
const lee: Connection = { kind: "github", id: "cred000000000001", label: "lee", baseUrl: "https://github.com", owner: null, account: true };

const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");

/** Renders inside a router (the setup steps link to Settings) with a query cache the test fills. */
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

const list = (props: Partial<Parameters<typeof RepoList>[0]>) => (
  <RepoList
    projectId={projectId}
    listsPending={false}
    listError={null}
    canConnect
    groups={[]}
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

test("nothing connected: owners and admins get three steps and Settings > GitHub, members whom to ask", async () => {
  const admin = await render(<GithubSetup canManage onOpen={() => {}} />);
  expect(admin).toContain(t("newService.githubSetup.title"));
  expect(admin).toContain(escaped(t("newService.githubSetup.step2")));
  expect(admin).toContain('href="/settings/github"');

  const member = await render(<GithubSetup canManage={false} onOpen={() => {}} />);
  expect(member).toContain(escaped(t("newService.githubSetup.member")));
  expect(member).not.toContain('href="/settings/github"');
});

test("loading shows skeleton rows, a failed load one calm line, and no project says to pick one", async () => {
  const loading = await render(list({ listsPending: true }));
  expect(loading).toContain('data-slot="skeleton"');
  expect(loading).toContain('aria-busy="true"');

  const down = new OpError("UNAVAILABLE", "The panel is restarting.");
  const failed = await render(list({ listError: down }));
  expect(failed).toContain(t("newService.repo.listFailed", { message: "The panel is restarting." }));
  expect(failed).not.toContain('data-slot="skeleton"');

  expect(await render(list({ projectId: "" }))).toContain(t("newService.repo.pickProject"));
});

test("someone who may create but not change services is told why there is nothing to pick", async () => {
  const html = await render(list({ canConnect: false, groups: [group(acme, { status: "loading" })] }));
  expect(html).toContain(escaped(t("newService.repo.cannotConnect")));
  expect(html).not.toContain('role="option"');
});

test("repositories show by installation and the connected account, with private or public; refused ones drop out", async () => {
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
        group(lee, { repos: [{ fullName: "lee/notes", private: true, defaultBranch: "main", updatedAt: null }] }),
        // FORBIDDEN: an installation not shared with this project.
        group({ ...acme, id: "inst000000000002", label: "other", owner: "other" }, { status: "hidden" }),
      ],
      selected: { connection: acme, repo: { fullName: "acme/docs", private: false, defaultBranch: "main", updatedAt: null } },
    }),
  );
  expect(html).toContain(escaped(t("newService.repo.group", { provider: "GitHub", name: "acme" })));
  expect(html).toContain(escaped(t("newService.repo.groupAccount", { login: "lee" })));
  expect(html).toContain("acme/shop-api");
  expect(html).toContain("lee/notes");
  expect(html).toContain(t("newService.repo.private"));
  expect(html).toContain(t("newService.repo.public"));
  expect(html).toContain(t("newService.repo.more"));
  expect(html).toMatch(/aria-selected="true"[^>]*>.*?acme\/docs/);
  expect(html).not.toContain("other");
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
        group(lee, { status: "error", error: new OpError("UNAVAILABLE", "GitHub answered 503.") }),
      ],
    }),
  );
  expect(html).toContain('data-slot="skeleton"');
  expect(html).toContain(t("newService.repo.groupFailed", { message: "GitHub answered 503." }));

  const none = await render(list({ groups: [group(acme, {}), group(lee, { status: "hidden" })] }));
  expect(none).toContain(t("newService.repo.noRepos"));
  const noMatch = await render(list({ groups: [group(acme, {})], query: "zzz" }));
  expect(noMatch).toContain(t("newService.repo.noMatch", { query: "zzz" }));
});

test("the line under the field says what the repository becomes", async () => {
  const note = async (text: string, decision: RepoDecision, onRetry?: () => void, tab?: "github" | "git") =>
    render(<RepoNote id="n" text={text} decision={decision} onRetry={onRetry} tab={tab} />);
  const ref = (url: string, host: string, path: string, ssh = false) => ({ url, host, path, ssh, ref: null });
  const repo = { fullName: "acme/shop-api", private: true, defaultBranch: "main", updatedAt: null };
  const githubRef = ref("https://github.com/acme/app.git", "github.com", "acme/app");

  expect(await note("", { type: "none", problem: "empty" })).toContain(escaped(t("newService.repo.hint")));
  expect(await note("", { type: "none", problem: "empty" }, undefined, "git")).toContain(escaped(t("newService.git.hint")));
  expect(await note("acme/shop-api", { type: "connected", found: { connection: acme, repo } })).toContain(
    "From your GitHub App (acme) - deploys on push",
  );
  expect(await note("lee/notes", { type: "connected", found: { connection: lee, repo } })).toContain(
    "From the connected GitHub account (@lee) - deploys on push",
  );
  expect(await note("acme/app", { type: "git", repo: githubRef, missedIn: null })).toContain(
    "Public GitHub repository github.com/acme/app",
  );
  // The Git repository tab points private GitHub repositories at the GitHub tab.
  expect(await note("x", { type: "git", repo: githubRef, missedIn: null }, undefined, "git")).toContain("Private? Use the GitHub tab.");
  // Not "public ... cannot read it": what happens, and what to do if it is private.
  const missed = await note("acme/app", { type: "git", repo: githubRef, missedIn: acme });
  expect(missed).toContain(escaped("Not in your GitHub App (acme) - cloned as public. Private? Give the App access first."));
  expect(missed).not.toContain("Public GitHub repository");
  expect(await note("x", { type: "git", repo: githubRef, missedIn: lee })).toContain(
    "Not a repository of the connected GitHub account (@lee) - cloned as public.",
  );
  expect(
    await note(
      "x",
      { type: "git", repo: ref("https://git.example.com/team/app.git", "git.example.com", "team/app"), missedIn: null },
      undefined,
      "git",
    ),
  ).toContain("Public git repository git.example.com/team/app");
  expect(
    await note("x", { type: "git", repo: ref("git@git.example.com:team/app.git", "git.example.com", "team/app", true), missedIn: null }),
  ).toContain("Cloned over SSH from git.example.com: add a deploy key on the Source tab, then deploy.");
  const credentials = await note("https://a:b@x.dev/r", { type: "none", problem: "credentials" });
  expect(credentials).toContain("text-destructive");
  expect(credentials).toContain("Remove the token from the URL - add it as a git credential on the Source tab after creating.");
  expect(await note("acme/app", { type: "none", problem: "shorthand" }, undefined, "git")).toContain("github.com/acme/app");
  expect(await note("gitlab.com/a/b", { type: "none", problem: "notGithub" })).toContain(escaped(t("newService.repo.problems.notGithub")));

  // A connection that did not answer: what failed, and Try again.
  const error = new OpError("UNAVAILABLE", "GitHub answered 502.");
  const unchecked = await note("x", { type: "unchecked", repo: githubRef, failed: acme, error }, () => {});
  expect(unchecked).toContain("Could not check your GitHub App (acme). GitHub answered 502.");
  expect(unchecked).toMatch(/<button[^>]*>Try again<\/button>/);
  expect(await note("x", { type: "unchecked", repo: githubRef, failed: lee, error }, () => {})).toContain(
    "Could not check the connected GitHub account (@lee). GitHub answered 502.",
  );
  expect(await note("x", { type: "unchecked", repo: githubRef, failed: "github", error }, () => {})).toContain(
    "Could not load your GitHub connections. GitHub answered 502.",
  );
  expect(await note("x", { type: "checking", repo: githubRef, needsProject: true })).toContain(
    "Pick a project to look for acme/app on GitHub.",
  );
});

test("the GitHub tab takes owner/repo and github.com addresses, nothing on another host", () => {
  expect(githubParse("acme/app")).toMatchObject({ ok: true, repo: { host: "github.com", path: "acme/app" } });
  expect(githubParse("https://github.com/acme/app/tree/main")).toMatchObject({ ok: true, repo: { path: "acme/app", ref: ["main"] } });
  expect(githubParse("git@github.com:acme/app.git")).toMatchObject({ ok: true, repo: { ssh: true } });
  expect(githubParse("gitlab.com/acme/app")).toEqual({ ok: false, problem: "notGithub" });
  expect(githubParse("")).toEqual({ ok: false, problem: "empty" });
});

/** The field's line for typed text, with what github.installations and the lookups answered in the cache. */
function Typed({ text }: { text: string }) {
  const source = useRepoSource({ projectId, text, picked: null, enabled: true });
  return <RepoNote id="n" text={text} decision={source.decision} onRetry={source.retry} />;
}

const installation = {
  id: acme.id,
  installationId: 55501,
  accountLogin: "acme",
  accountType: "Organization",
  repositorySelection: "selected",
  suspended: false,
  manageUrl: "https://github.com/organizations/acme/settings/installations/55501",
  createdAt: "2026-10-01T00:00:00.000Z",
};
const installations = (account: { id: string; login: string } | null = null) => ({
  installations: [installation],
  installUrl: "https://github.com/apps/acme-seylo/installations/new",
  account,
  hidden: false,
});
const viewer = (role: string) => ({ viewer: { id: "user000000000001", email: "you@example.com", name: "", role }, via: "session" });
const branchesKey = (repo: string) => opQueryKey(github.branches, { projectId, installationId: acme.id, repo });
const accountBranchesKey = (repo: string) => opQueryKey(github.branches, { projectId, accountId: lee.id, repo });
/** The installation reads the repository: github.branches answered. */
const reads =
  (repo: string, defaultBranch = "main") =>
  (client: QueryClient) =>
    client.setQueryData(branchesKey(repo), { branches: [defaultBranch], defaultBranch });
const lists =
  (account: { id: string; login: string } | null = null) =>
  (client: QueryClient) => {
    client.setQueryData(opQueryKey(auth.whoami, {}), viewer("owner"));
    client.setQueryData(opQueryKey(github.installations, {}), installations(account));
  };

test("typed owner/repo the installation reads becomes the GitHub App source; one it cannot read a public URL that says so", async () => {
  const found = await render(<Typed text="acme/shop-api" />, (client) => {
    lists()(client);
    reads("acme/shop-api")(client);
  });
  expect(found).toContain("From your GitHub App (acme) - deploys on push");

  const missed = await render(<Typed text="acme/secret" />, (client) => {
    lists()(client);
    failedQuery(client, branchesKey("acme/secret"), new OpError("NOT_FOUND", "The App cannot read acme/secret.", { field: "repo" }));
  });
  expect(missed).toContain(escaped("Not in your GitHub App (acme) - cloned as public."));

  // While the installation has not answered: checking, so Create waits.
  const checking = await render(<Typed text="acme/shop-api" />, lists());
  expect(checking).toContain(t("newService.repo.checking", { path: "acme/shop-api" }));

  // Another account and no connected account: no lookup at all.
  expect(await render(<Typed text="torvalds/linux" />, lists())).toContain("Public GitHub repository github.com/torvalds/linux");
});

test("a repository no installation reads is asked of the connected account, and read through it", async () => {
  const account = { id: lee.id, login: "lee" };
  const viaAccount = await render(<Typed text="lee/notes" />, (client) => {
    lists(account)(client);
    client.setQueryData(accountBranchesKey("lee/notes"), { branches: ["main"], defaultBranch: "main" });
  });
  expect(viaAccount).toContain("From the connected GitHub account (@lee) - deploys on push");

  // acme's installation answers first: the App wins over the account.
  const viaApp = await render(<Typed text="acme/shop-api" />, (client) => {
    lists(account)(client);
    reads("acme/shop-api")(client);
    client.setQueryData(accountBranchesKey("acme/shop-api"), { branches: ["main"], defaultBranch: "main" });
  });
  expect(viaApp).toContain("From your GitHub App (acme) - deploys on push");

  const neither = await render(<Typed text="lee/secret" />, (client) => {
    lists(account)(client);
    failedQuery(client, accountBranchesKey("lee/secret"), new OpError("NOT_FOUND", "It cannot read lee/secret.", { field: "repo" }));
  });
  expect(neither).toContain("Not a repository of the connected GitHub account (@lee) - cloned as public.");
});

test("a lookup or a list that failed leaves the field unchecked with Try again, never a public URL", async () => {
  const down = await render(<Typed text="acme/private-api" />, (client) => {
    lists()(client);
    failedQuery(client, branchesKey("acme/private-api"), new OpError("UNAVAILABLE", "GitHub did not answer."));
  });
  expect(down).toContain("Could not check your GitHub App (acme). GitHub did not answer.");
  expect(down).toContain(t("newService.repo.retry"));
  expect(down).not.toContain("Public GitHub repository");

  const noInstallations = await render(<Typed text="acme/private" />, (client) => {
    client.setQueryData(opQueryKey(auth.whoami, {}), viewer("owner"));
    failedQuery(client, opQueryKey(github.installations, {}), new OpError("UNAVAILABLE", "The panel is restarting."));
  });
  expect(noInstallations).toContain("Could not load your GitHub connections. The panel is restarting.");
  expect(noInstallations).not.toContain("Public GitHub repository");
});

test("a member without services.update gets plain git URLs: no lookup that would end in a half-made app", async () => {
  const html = await render(<Typed text="acme/shop-api" />, (client) => {
    lists()(client);
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

test("while the installation list loads, a typed repository is checking", async () => {
  expect(await render(<Typed text="https://github.com/acme/app.git" />)).toContain(t("newService.repo.checking", { path: "acme/app" }));
});
