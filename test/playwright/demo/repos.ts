// Demo answers for picking a repository: the acme GitHub App installation,
// the connected GitHub account (withAccount) and a GitLab connection with
// their repositories (filtered by the query and paged like the panel),
// branches per repository (NOT_FOUND for one the connection does not
// hold), git.branches for a plain URL, and creating and connecting a new
// app. Same world as service.ts; loosely typed like the rest of demo/.

import { DemoRefusal } from "./refusal";
import { handlers as serviceHandlers, ids } from "./service";

type Input = Record<string, any>;

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const hour = 3_600_000;
const day = 24 * hour;

/** The installation service.ts connects acme/shop-api and acme/shop-worker through. */
export const installation = {
  id: "i000000000000001",
  installationId: 55501,
  accountLogin: "acme",
  accountType: "Organization",
  repositorySelection: "selected",
  suspended: false,
  manageUrl: "https://github.com/organizations/acme/settings/installations/55501",
  createdAt: ago(59 * day),
};

const personal = {
  id: "i000000000000002",
  installationId: 55502,
  accountLogin: "lee-park",
  accountType: "User",
  repositorySelection: "all",
  suspended: false,
  manageUrl: "https://github.com/settings/installations/55502",
  createdAt: ago(20 * day),
};

export const gitlabConnection = {
  id: "gp0000000000000a",
  kind: "gitlab",
  name: "Company GitLab",
  url: "https://gitlab.com",
  host: "gitlab.com",
  workspace: null,
  authKind: "token",
  account: "deploy-bot",
  username: null,
  statusNotes: true,
  usedBy: 1,
  createdAt: ago(20 * day),
  updatedAt: ago(20 * day),
};

/**
 * The panel's connected GitHub account (Settings > GitHub, a device login
 * or a token). Not connected in the default world: the specs that need it
 * answer github.installations with withAccount.
 */
export const githubAccount = { id: "cred00000000000a", login: "dana" };

/** What the account reads: its own repositories and one of acme's the App was not given. */
export const accountRepos = [
  { fullName: "dana/notes", private: true, defaultBranch: "main", pushedAt: ago(4 * hour) },
  { fullName: "acme/legacy-api", private: true, defaultBranch: "master", pushedAt: ago(12 * day) },
];

/** github.repos per installation id. */
export const githubRepos: Record<string, { fullName: string; private: boolean; defaultBranch: string; pushedAt: string }[]> = {
  [installation.id]: [
    { fullName: "acme/shop-api", private: true, defaultBranch: "main", pushedAt: ago(2 * hour) },
    { fullName: "acme/shop-worker", private: true, defaultBranch: "main", pushedAt: ago(day) },
    { fullName: "acme/storefront", private: false, defaultBranch: "trunk", pushedAt: ago(3 * day) },
    { fullName: "acme/docs", private: false, defaultBranch: "main", pushedAt: ago(9 * day) },
  ],
  [personal.id]: [{ fullName: "lee-park/blog", private: false, defaultBranch: "main", pushedAt: ago(6 * day) }],
};

export const gitlabRepos = [
  { fullName: "acme/platform/shop", private: true, defaultBranch: "main", updatedAt: ago(5 * hour) },
  { fullName: "acme/site", private: false, defaultBranch: "trunk", updatedAt: ago(2 * day) },
];

const branchesOf: Record<string, string[]> = {
  "acme/shop-api": ["main", "dev", "feat/queue"],
  "acme/shop-worker": ["main", "dev"],
  "acme/storefront": ["trunk", "next", "release/2.0"],
  "acme/docs": ["main"],
  "lee-park/blog": ["main", "drafts"],
  "acme/platform/shop": ["main", "feat/checkout"],
  "acme/site": ["trunk", "next"],
  "dana/notes": ["main", "drafts"],
  "acme/legacy-api": ["master", "v2"],
};

/** Page size of github.repos and gitProviders.repos in the panel. */
const pageSize = 30;

function page<T extends { fullName: string }>(all: T[], input: Input) {
  const query = String(input.query ?? "").toLowerCase();
  const list = all.filter((r) => !query || r.fullName.toLowerCase().includes(query));
  const at = Number(input.page ?? 1);
  return { repos: list.slice((at - 1) * pageSize, at * pageSize), hasMore: list.length > at * pageSize };
}

/**
 * A repository's branches through a connection that holds it, as the panel
 * answers github.branches and gitProviders.branches; NOT_FOUND for the repo
 * when the connection cannot read it (the New app dialog looks typed
 * repositories up this way).
 */
function branches(held: { fullName: string }[], input: Input) {
  const repo = held.find((r) => r.fullName.toLowerCase() === String(input.repo).toLowerCase())?.fullName;
  if (!repo) {
    throw new DemoRefusal(404, "NOT_FOUND", `The connection cannot read ${input.repo}, or there is no such repository.`, { field: "repo" });
  }
  const list = branchesOf[repo] ?? ["main"];
  return { branches: list, defaultBranch: list[0] ?? null };
}

/** A public repository's branches as git ls-remote would list them, by URL. */
const publicBranches: Record<string, { branches: string[]; defaultBranch: string | null }> = {
  "https://github.com/vercel/next.js.git": { branches: ["canary", "main", "next-15-5"], defaultBranch: "canary" },
  "https://github.com/acme/secret.git": { branches: ["main"], defaultBranch: "main" },
};

const createdService = (input: Input) => ({ ...(serviceHandlers["services.get"]?.({ serviceId: ids.api }) as object), name: input.name });

/** What a GitHub op reads through: the account (accountId) or an installation. */
const heldBy = (input: Input) => (input.accountId === githubAccount.id ? accountRepos : (githubRepos[String(input.installationId)] ?? []));

const installations = (account: typeof githubAccount | null) => ({
  installations: [installation, personal],
  installUrl: "https://github.com/apps/acme-seylo/installations/new",
  account,
  hidden: false,
});

/** github.installations with the connected account, for the specs that use it. */
export const withAccount = { "github.installations": () => installations(githubAccount) };

export const handlers: Record<string, (input: Input) => unknown> = {
  "github.installations": () => installations(null),
  "github.repos": (input) => page(heldBy(input), input),
  "github.branches": (input) => branches(heldBy(input), input),
  // acme/shop-api has a Dockerfile at its root; the other demo repositories do not.
  "github.detectBuilder": (input) => ({ dockerfile: input.repo === "acme/shop-api" }),
  "github.repoWebhook": () => ({ configured: false, repo: null, url: null, created: false, error: null, lastDeliveryAt: null }),
  "gitProviders.list": () => ({ items: [gitlabConnection], hidden: false }),
  "gitProviders.repos": (input) => page(gitlabRepos, input),
  "gitProviders.branches": (input) => branches(gitlabRepos, input),
  "git.branches": (input) => publicBranches[String(input.url)] ?? { branches: ["main", "develop"], defaultBranch: "main" },
  "services.create": createdService,
  "github.connectRepo": (input) => serviceHandlers["services.get"]?.({ serviceId: input.serviceId }),
  "gitProviders.connectRepo": (input) => serviceHandlers["services.get"]?.({ serviceId: input.serviceId }),
  "deployments.deploy": (input) => (serviceHandlers["deployments.get"]?.({ deploymentId: "d000000000000011" }) as { deployment: unknown }).deployment,
};
