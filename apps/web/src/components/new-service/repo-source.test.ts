import { expect, test } from "bun:test";
import { OpError, services } from "@seylo/ops";
import { parseRepoInput } from "./repo-input";
import {
  type Connection,
  connectionsOf,
  decideSource,
  type FoundRepo,
  knownHostsOf,
  listFor,
  lookupStateOf,
  mayConnectIn,
  pathIn,
  type RepoInfo,
  type RepoLookup,
  repoKeyOf,
  sourceFor,
  textFor,
} from "./repo-source";

const acme: Connection = { kind: "github", id: "inst000000000001", label: "acme", baseUrl: "https://github.com", owner: "acme" };
const gitlab: Connection = { kind: "gitlab", id: "gp00000000000001", label: "Company GitLab", baseUrl: "https://gitlab.com", owner: null };
const gitea: Connection = {
  kind: "gitea",
  id: "gp00000000000002",
  label: "Home Gitea",
  baseUrl: "https://git.example.com/gitea",
  owner: null,
};
const bitbucket: Connection = {
  kind: "bitbucket",
  id: "gp00000000000003",
  label: "Agency",
  baseUrl: "https://bitbucket.org",
  owner: "agency",
};

const repo = (fullName: string, over: Partial<RepoInfo> = {}): RepoInfo => ({
  fullName,
  private: true,
  defaultBranch: "main",
  updatedAt: null,
  ...over,
});
const parsed = (text: string) => {
  const result = parseRepoInput(text);
  if (!result.ok) throw new Error(text);
  return result.repo;
};
const answered = (connection: Connection, path: string, state: RepoLookup["state"]): RepoLookup => ({
  connection,
  path,
  state,
  defaultBranch: null,
  error: null,
});
const found = (connection: Connection, path: string, defaultBranch = "main"): RepoLookup => ({
  ...answered(connection, path, "found"),
  defaultBranch,
});

test("connections: installations that are not suspended and every provider, none from a hidden list", () => {
  const installations = {
    installations: [
      { id: "inst000000000001", accountLogin: "acme", suspended: false },
      { id: "inst000000000002", accountLogin: "old-org", suspended: true },
    ],
  };
  const providers = {
    items: [{ id: gitlab.id, kind: "gitlab" as const, name: "Company GitLab", url: "https://gitlab.com", workspace: null }],
  };
  expect(connectionsOf(installations, providers)).toEqual([acme, gitlab]);
  expect(connectionsOf({ ...installations, hidden: true }, { items: [], hidden: true })).toEqual([]);
  expect(connectionsOf(undefined, undefined)).toEqual([]);
});

test("a typed repository can be in a connection of its host, and a GitHub one only in its owner's installation", () => {
  expect(pathIn(acme, parsed("acme/app"))).toBe("acme/app");
  expect(pathIn(acme, parsed("ACME/app"))).toBe("ACME/app");
  expect(pathIn(acme, parsed("git@github.com:acme/app.git"))).toBe("acme/app");
  expect(pathIn(acme, parsed("other/app"))).toBeNull();
  expect(pathIn(acme, parsed("gitlab.com/acme/app"))).toBeNull();
  expect(pathIn(gitlab, parsed("gitlab.com/group/sub/repo"))).toBe("group/sub/repo");
  expect(pathIn(gitlab, parsed("git@gitlab.com:group/repo.git"))).toBe("group/repo");
  expect(pathIn(gitlab, parsed("acme/app"))).toBeNull();
  // A self-managed server under a path: the path after it is the repository.
  expect(pathIn(gitea, parsed("https://git.example.com/gitea/team/app.git"))).toBe("team/app");
  expect(pathIn(gitea, parsed("git.example.com/team/app"))).toBeNull();
  expect(pathIn(bitbucket, parsed("bitbucket.org/agency/site"))).toBe("agency/site");
  expect(pathIn(bitbucket, parsed("bitbucket.org/someone-else/site"))).toBeNull();
});

test("the field text for a picked repository finds the same repository again", () => {
  const picks: FoundRepo[] = [
    { connection: acme, repo: repo("acme/shop-api") },
    { connection: gitlab, repo: repo("acme/platform/shop") },
    { connection: gitea, repo: repo("team/app") },
  ];
  for (const found of picks) {
    const text = textFor(found);
    expect(pathIn(found.connection, parsed(text))).toBe(found.repo.fullName);
  }
  expect(textFor(picks[0] as FoundRepo)).toBe("acme/shop-api");
  expect(textFor(picks[1] as FoundRepo)).toBe("gitlab.com/acme/platform/shop");
  expect(textFor(picks[2] as FoundRepo)).toBe("git.example.com/gitea/team/app");
});

test("picked from Browse: the connection's source with deploy on push, like the Source tab", () => {
  const decision = decideSource(parseRepoInput("acme/shop-api"), { connection: acme, repo: repo("acme/shop-api") }, []);
  expect(decision.type).toBe("connected");
  expect(sourceFor(decision, "main")).toEqual({
    type: "github",
    installationId: acme.id,
    repo: "acme/shop-api",
    branch: "main",
    deployOnPush: true,
  });
  const provider = decideSource(parseRepoInput("x"), { connection: gitlab, repo: repo("acme/platform/shop") }, []);
  expect(sourceFor(provider, "dev")).toEqual({
    type: "provider",
    providerId: gitlab.id,
    provider: "gitlab",
    repo: "acme/platform/shop",
    branch: "dev",
    deployOnPush: true,
  });
});

test("typed owner/repo that the installation reads becomes a GitHub source, with the repository's default branch", () => {
  const decision = decideSource(parseRepoInput("acme/shop-api"), null, [found(acme, "acme/shop-api", "trunk")]);
  expect(decision).toEqual({
    type: "connected",
    found: { connection: acme, repo: { fullName: "acme/shop-api", private: null, defaultBranch: "trunk", updatedAt: null } },
  });
  expect(sourceFor(decision, "main")).toMatchObject({ type: "github", repo: "acme/shop-api" });
});

test("typed owner/repo that the installation cannot read (NOT_FOUND) is a public GitHub URL, and says which one missed it", () => {
  const typed = parseRepoInput("acme/secret");
  const decision = decideSource(typed, null, [answered(acme, "acme/secret", "missing")]);
  expect(decision).toMatchObject({ type: "git", missedIn: acme });
  expect(sourceFor(decision, "main")).toEqual({
    type: "git",
    url: "https://github.com/acme/secret.git",
    branch: "main",
    credentialId: null,
    deployOnPush: false,
  });
  // Another account entirely: nothing to look up.
  expect(decideSource(parseRepoInput("torvalds/linux"), null, [])).toMatchObject({ type: "git", missedIn: null });
});

test("a connection that has not answered keeps the field checking; one that refused does not hold it, quietly", () => {
  const typed = parseRepoInput("gitlab.com/group/app");
  const pending = answered(gitlab, "group/app", "pending");
  expect(decideSource(typed, null, [pending]).type).toBe("checking");
  expect(sourceFor(decideSource(typed, null, [pending]), "main")).toBeNull();
  // FORBIDDEN for someone the connection is not shared with in this project: a plain URL, quietly.
  expect(decideSource(typed, null, [answered(gitlab, "group/app", "refused")])).toMatchObject({ type: "git", missedIn: null });
  // Two connections of the same host: the first that reads it wins.
  const second: Connection = { ...gitlab, id: "gp00000000000009", label: "Other GitLab" };
  const decision = decideSource(typed, null, [answered(gitlab, "group/app", "missing"), found(second, "group/app")]);
  expect(decision).toMatchObject({ type: "connected", found: { connection: second } });
});

test("a connection that failed to answer leaves the field unchecked: no public URL is made of a repository it may hold", () => {
  // GitLab answering 502, a rate limit, a timeout: nothing says the repository is public.
  const typed = parseRepoInput("gitlab.com/acme/private-api");
  const error = new OpError("UNAVAILABLE", "GitLab answered 502.");
  const failed: RepoLookup = { ...answered(gitlab, "acme/private-api", "failed"), error };
  const decision = decideSource(typed, null, [failed]);
  expect(decision).toMatchObject({ type: "unchecked", failed: gitlab, error });
  expect(sourceFor(decision, "main")).toBeNull();
  // Another connection reading it is still an answer.
  const second: Connection = { ...gitlab, id: "gp00000000000009", label: "Other GitLab" };
  expect(decideSource(typed, null, [failed, found(second, "acme/private-api")])).toMatchObject({ type: "connected" });
  // One that cannot read it does not outweigh one that did not answer.
  expect(decideSource(typed, null, [answered(second, "acme/private-api", "missing"), failed]).type).toBe("unchecked");
});

test("only NOT_FOUND for the repository and FORBIDDEN are answers", () => {
  expect(lookupStateOf(new OpError("NOT_FOUND", "The App cannot read acme/x.", { field: "repo" }))).toBe("missing");
  expect(lookupStateOf(new OpError("FORBIDDEN", "Only admins can use this GitHub installation in a new project."))).toBe("refused");
  // The connection itself is gone: that says nothing about the repository.
  expect(lookupStateOf(new OpError("NOT_FOUND", "No git provider connection with this id.", { field: "providerId" }))).toBe("failed");
  for (const code of ["UNAVAILABLE", "INTERNAL", "RATE_LIMITED", "BAD_REQUEST"] as const) {
    expect(lookupStateOf(new OpError(code, "x"))).toBe("failed");
  }
  expect(lookupStateOf(new TypeError("Failed to fetch"))).toBe("failed");
});

test("names the lookups would refuse are not looked up", () => {
  // github.branches takes owner/name of [A-Za-z0-9_.-]; a ~ cannot be a GitHub repository.
  expect(pathIn(acme, parsed("github.com/acme/app~1"))).toBeNull();
  expect(pathIn(gitlab, parsed("gitlab.com/acme/app"))).toBe("acme/app");
  expect(pathIn(gitlab, parsed("gitlab.com/acme/app~1"))).toBeNull();
});

test("a typed repository's connections come from the GitHub App list for github.com and the providers for the rest", () => {
  expect(listFor(parsed("acme/app"))).toBe("github");
  expect(listFor(parsed("git@github.com:acme/app.git"))).toBe("github");
  expect(listFor(parsed("gitlab.com/acme/app"))).toBe("providers");
  expect(listFor(parsed("git.example.com:3000/team/app"))).toBe("providers");
});

test("the repository key is the same however it is typed, and changes with the repository", () => {
  const key = (text: string) => repoKeyOf(parseRepoInput(text));
  expect(key("acme/app")).toBe("github.com/acme/app");
  expect(key("https://github.com/Acme/App.git")).toBe("github.com/acme/app");
  expect(key("git@github.com:acme/app.git")).toBe("github.com/acme/app");
  expect(key("https://github.com/acme/app/tree/dev")).toBe("github.com/acme/app");
  expect(key("acme/api")).not.toBe(key("acme/app"));
  expect(key("")).toBe("");
});

test("the connections' servers are known hosts, under their path", () => {
  expect(knownHostsOf([acme, gitlab, gitea, bitbucket])).toEqual([
    { host: "github.com", kind: "github", prefix: "" },
    { host: "gitlab.com", kind: "gitlab", prefix: "" },
    { host: "git.example.com", kind: "gitea", prefix: "gitea" },
    { host: "bitbucket.org", kind: "bitbucket", prefix: "" },
  ]);
  // A self-managed Gitea's page address reaches its connection as the repository.
  const page = parseRepoInput("https://git.example.com/gitea/team/app/src/branch/main/docs", knownHostsOf([gitea]));
  expect(page.ok && pathIn(gitea, page.repo)).toBe("team/app");
});

test("connecting needs services.update in the project: owners and admins, or a member's project grant", () => {
  const grant = (actions: string[], scopeId = "prj1prj1prj1prj1", scopeType: "project" | "service" = "project") => ({
    scopeType,
    scopeId,
    actions,
  });
  expect(mayConnectIn("owner", [], "prj1prj1prj1prj1")).toBe(true);
  expect(mayConnectIn("admin", [], "prj1prj1prj1prj1")).toBe(true);
  expect(mayConnectIn("member", [grant(["services.create", "services.update"])], "prj1prj1prj1prj1")).toBe(true);
  expect(mayConnectIn("member", [grant(["services.*"])], "prj1prj1prj1prj1")).toBe(true);
  expect(mayConnectIn("member", [grant(["*"])], "prj1prj1prj1prj1")).toBe(true);
  // Create and deploy without update: connectRepo would refuse after the app exists.
  expect(mayConnectIn("member", [grant(["services.create", "services.deploy"])], "prj1prj1prj1prj1")).toBe(false);
  expect(mayConnectIn("member", [grant(["services.update"], "prj2prj2prj2prj2")], "prj1prj1prj1prj1")).toBe(false);
  expect(mayConnectIn("member", [grant(["services.update"], "svc1svc1svc1svc1", "service")], "prj1prj1prj1prj1")).toBe(false);
});

test("pasted URLs stay as written, and nothing typed creates nothing", () => {
  const url = "https://git.example.com/team/app.git";
  expect(sourceFor(decideSource(parseRepoInput(url), null, []), "trunk")).toEqual({
    type: "git",
    url,
    branch: "trunk",
    credentialId: null,
    deployOnPush: false,
  });
  expect(decideSource(parseRepoInput(""), null, [])).toEqual({ type: "none", problem: "empty" });
  expect(sourceFor(decideSource(parseRepoInput("http://x.example.com/a/b"), null, []), "main")).toBeNull();
});

test("every source it makes is one the services.Source contract accepts", () => {
  const sources = [
    sourceFor(decideSource(parseRepoInput("acme/shop-api"), { connection: acme, repo: repo("acme/shop-api") }, []), "main"),
    sourceFor(decideSource(parseRepoInput("x"), { connection: gitlab, repo: repo("acme/platform/shop") }, []), "feat/a"),
    sourceFor(decideSource(parseRepoInput("acme/app"), null, []), "main"),
    sourceFor(decideSource(parseRepoInput("git@git.example.com:team/app.git"), null, []), "main"),
  ];
  const variants = services.Source.anyOf as unknown as { properties: Record<string, { const?: string; pattern?: string }> }[];
  for (const source of sources) {
    const variant = variants.find((v) => v.properties.type?.const === source?.type);
    expect(variant).toBeDefined();
    const fields = Object.entries(variant?.properties ?? {});
    expect(Object.keys(source ?? {}).sort()).toEqual(fields.map(([key]) => key).sort());
    for (const [key, schema] of fields) {
      if (schema.pattern) expect(new RegExp(schema.pattern).test(String((source as Record<string, unknown>)[key]))).toBe(true);
    }
  }
});
