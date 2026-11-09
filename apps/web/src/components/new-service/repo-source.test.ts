import { expect, test } from "bun:test";
import { services } from "@seylo/ops";
import { parseRepoInput } from "./repo-input";
import {
  type Connection,
  connectionsOf,
  decideSource,
  type FoundRepo,
  pathIn,
  type RepoInfo,
  type RepoLookup,
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
const done = (connection: Connection, path: string, repos: RepoInfo[]): RepoLookup => ({ connection, path, state: "done", repos });

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

test("typed owner/repo that the installation lists becomes a GitHub source, with the name as GitHub spells it", () => {
  const decision = decideSource(parseRepoInput("ACME/Shop-API"), null, [done(acme, "ACME/Shop-API", [repo("acme/shop-api")])]);
  expect(decision).toEqual({ type: "connected", found: { connection: acme, repo: repo("acme/shop-api") } });
  expect(sourceFor(decision, "main")).toMatchObject({ type: "github", repo: "acme/shop-api" });
});

test("typed owner/repo that no installation lists is a public GitHub URL, and says which one missed it", () => {
  const typed = parseRepoInput("acme/secret");
  const decision = decideSource(typed, null, [done(acme, "acme/secret", [repo("acme/secret-sauce")])]);
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

test("a connection that has not answered keeps the field checking; one that failed does not hold it", () => {
  const typed = parseRepoInput("gitlab.com/group/app");
  const pending: RepoLookup = { connection: gitlab, path: "group/app", state: "pending", repos: [] };
  expect(decideSource(typed, null, [pending]).type).toBe("checking");
  expect(sourceFor(decideSource(typed, null, [pending]), "main")).toBeNull();
  // FORBIDDEN for someone the connection is not shared with in this project: a plain URL, quietly.
  const failed: RepoLookup = { ...pending, state: "failed" };
  expect(decideSource(typed, null, [failed])).toMatchObject({ type: "git", missedIn: null });
  // Two connections of the same host: the first that lists it wins.
  const second: Connection = { ...gitlab, id: "gp00000000000009", label: "Other GitLab" };
  const decision = decideSource(typed, null, [done(gitlab, "group/app", []), done(second, "group/app", [repo("group/app")])]);
  expect(decision).toMatchObject({ type: "connected", found: { connection: second } });
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
