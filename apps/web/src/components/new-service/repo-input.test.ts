import { expect, test } from "bun:test";
import { GitUrl } from "@seylo/ops";
import { branchFromRef, type KnownHost, parseRepoInput, type RepoRef } from "./repo-input";

const ok = (text: string, known: KnownHost[] = []): RepoRef => {
  const parsed = parseRepoInput(text, known);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.problem}`);
  return parsed.repo;
};
const problem = (text: string) => {
  const parsed = parseRepoInput(text);
  return parsed.ok ? null : parsed.problem;
};

test("owner/repo is a GitHub repository, with or without .git", () => {
  expect(ok("acme/app")).toEqual({
    url: "https://github.com/acme/app.git",
    host: "github.com",
    path: "acme/app",
    ssh: false,
    ref: null,
  });
  expect(ok("  acme/app.git  ")).toEqual(ok("acme/app"));
  expect(ok("Acme-Labs/my.site_v2").url).toBe("https://github.com/Acme-Labs/my.site_v2.git");
  // GitHub owners have no dots or underscores: those are hosts or nothing.
  expect(problem("acme_labs/app")).toBe("invalid");
  expect(problem("acme/..")).toBe("invalid");
  expect(problem("acme")).toBe("invalid");
});

test("the Git repository tab takes full addresses only: owner/repo is the GitHub tab's", () => {
  const full = (text: string) => parseRepoInput(text, [], { shorthand: false });
  expect(full("acme/app")).toEqual({ ok: false, problem: "shorthand" });
  expect(full("github.com/acme/app")).toMatchObject({ ok: true, repo: { url: "https://github.com/acme/app.git" } });
  expect(full("https://git.example.com/team/app.git")).toMatchObject({ ok: true, repo: { host: "git.example.com" } });
  expect(full("git@git.example.com:team/app.git")).toMatchObject({ ok: true, repo: { ssh: true } });
  expect(full("ssh://git@git.example.com:2222/team/app.git")).toMatchObject({ ok: true, repo: { ssh: true } });
  expect(full("gitlab.com/group/sub/app")).toMatchObject({ ok: true, repo: { path: "group/sub/app" } });
});

test("a host and path without a scheme is an https repository", () => {
  expect(ok("github.com/acme/app")).toEqual(ok("acme/app"));
  expect(ok("github.com/acme/app.git/")).toEqual(ok("acme/app"));
  expect(ok("gitlab.com/group/sub/repo")).toEqual({
    url: "https://gitlab.com/group/sub/repo.git",
    host: "gitlab.com",
    path: "group/sub/repo",
    ssh: false,
    ref: null,
  });
  expect(ok("bitbucket.org/acme/app").url).toBe("https://bitbucket.org/acme/app.git");
  // Other hosts keep the path as written: some serve repositories without .git only.
  expect(ok("git.example.com:3000/team/app")).toEqual({
    url: "https://git.example.com:3000/team/app",
    host: "git.example.com:3000",
    path: "team/app",
    ssh: false,
    ref: null,
  });
  expect(ok("Git.Example.com/team/app.git").url).toBe("https://git.example.com/team/app.git");
  expect(ok("localhost:3000/team/app").host).toBe("localhost:3000");
  expect(problem("git.example.com")).toBe("invalid");
  expect(problem("git.example.com/team//app")).toBe("invalid");
});

test("full URLs: https, ssh:// and git@host:path", () => {
  expect(ok("https://git.example.com/team/app.git")).toEqual({
    url: "https://git.example.com/team/app.git",
    host: "git.example.com",
    path: "team/app",
    ssh: false,
    ref: null,
  });
  expect(ok("https://dev.azure.com/acme/shop/_git/api").url).toBe("https://dev.azure.com/acme/shop/_git/api");
  expect(ok("https://github.com/acme/app").url).toBe("https://github.com/acme/app.git");
  expect(ok("HTTPS://GitHub.com/acme/app.git")).toEqual(ok("acme/app"));
  expect(ok("ssh://git@git.example.com:2222/team/app.git")).toEqual({
    url: "ssh://git@git.example.com:2222/team/app.git",
    host: "git.example.com:2222",
    path: "team/app",
    ssh: true,
    ref: null,
  });
  expect(ok("git@github.com:acme/app.git")).toEqual({
    url: "git@github.com:acme/app.git",
    host: "github.com",
    path: "acme/app",
    ssh: true,
    ref: null,
  });
  expect(ok("git@gitlab.com:group/sub/repo.git").path).toBe("group/sub/repo");
});

test("page addresses of well-known hosts give the repository and what follows tree/ or src/", () => {
  expect(ok("https://github.com/acme/app/tree/feat/queue")).toMatchObject({
    url: "https://github.com/acme/app.git",
    ref: ["feat", "queue"],
  });
  expect(ok("github.com/acme/app/blob/main/README.md")).toMatchObject({ path: "acme/app", ref: null });
  expect(ok("https://github.com/acme/app?tab=readme#install").url).toBe("https://github.com/acme/app.git");
  expect(ok("https://gitlab.com/group/sub/repo/-/tree/dev")).toMatchObject({ path: "group/sub/repo", ref: ["dev"] });
  expect(ok("https://bitbucket.org/acme/app/src/release/")).toMatchObject({ path: "acme/app", ref: ["release"] });
  expect(ok("https://codeberg.org/acme/app/src/branch/next")).toMatchObject({ path: "acme/app", ref: ["next"] });
  // A monorepo folder link: the folder is part of the ref, not of the repository.
  expect(ok("https://github.com/acme/app/tree/main/apps/web")).toMatchObject({ path: "acme/app", ref: ["main", "apps", "web"] });
  expect(ok("https://gitlab.com/acme/app/-/tree/main/src")).toMatchObject({ path: "acme/app", ref: ["main", "src"] });
  expect(ok("https://codeberg.org/acme/app/src/branch/main/docs")).toMatchObject({ path: "acme/app", ref: ["main", "docs"] });
  expect(ok("https://codeberg.org/acme/app/src/commit/3f2a9c1")).toMatchObject({ path: "acme/app", ref: null });
  expect(problem("https://github.com/acme")).toBe("invalid");
});

test("an older gitlab.com page address without /-/ ends the project path at tree or blob, which GitLab reserves", () => {
  expect(ok("https://gitlab.com/acme/app/tree/main")).toEqual({
    url: "https://gitlab.com/acme/app.git",
    host: "gitlab.com",
    path: "acme/app",
    ssh: false,
    ref: ["main"],
  });
  expect(ok("gitlab.com/group/sub/app/blob/main/README.md")).toMatchObject({ path: "group/sub/app", ref: null });
  expect(ok("https://gitlab.com/group/sub/app/-/merge_requests/12")).toMatchObject({ path: "group/sub/app", ref: null });
});

test("page addresses of a connection's own GitLab or Gitea server are read by its kind", () => {
  const gitlab: KnownHost = { host: "gitlab.example.com", kind: "gitlab", prefix: "" };
  const gitea: KnownHost = { host: "git.example.com", kind: "gitea", prefix: "" };
  const prefixed: KnownHost = { host: "code.example.com", kind: "gitea", prefix: "gitea" };
  // Without the connection the server is unknown: the path stays as written.
  expect(ok("https://gitlab.example.com/group/sub/app/-/tree/main").path).toBe("group/sub/app/-/tree/main");
  expect(ok("https://gitlab.example.com/group/sub/app/-/tree/main", [gitlab])).toEqual({
    url: "https://gitlab.example.com/group/sub/app.git",
    host: "gitlab.example.com",
    path: "group/sub/app",
    ssh: false,
    ref: ["main"],
  });
  expect(ok("https://git.example.com/team/app/src/branch/main", [gitea])).toEqual({
    url: "https://git.example.com/team/app.git",
    host: "git.example.com",
    path: "team/app",
    ssh: false,
    ref: ["main"],
  });
  // A Gitea repository may be called src: owner/name come first.
  expect(ok("git.example.com/team/src/src/branch/dev", [gitea])).toMatchObject({ path: "team/src", ref: ["dev"] });
  // A server under a path keeps it in the repository's path.
  expect(ok("https://code.example.com/gitea/team/app/src/branch/main", [prefixed])).toMatchObject({
    url: "https://code.example.com/gitea/team/app.git",
    path: "gitea/team/app",
    ref: ["main"],
  });
  // Another path on that host is not the server's.
  expect(ok("https://code.example.com/other/team/app", [prefixed]).path).toBe("other/team/app");
});

test("the branch of a page address is the longest start of its ref that is a branch; without a list, its first segment", () => {
  const branches = ["main", "dev", "feat/queue"];
  expect(branchFromRef(["main", "apps", "web"], branches)).toBe("main");
  expect(branchFromRef(["feat", "queue", "src", "app"], branches)).toBe("feat/queue");
  expect(branchFromRef(["feat", "queue"], branches)).toBe("feat/queue");
  // Nothing matches (a commit, a tag): no branch, so the default applies.
  expect(branchFromRef(["v2.0", "src"], branches)).toBeNull();
  expect(branchFromRef(["main", "apps", "web"], null)).toBe("main");
  // Bitbucket's src/<commit>/ is no branch.
  expect(branchFromRef(["3f2a9c1e5b7d", "README.md"], null)).toBeNull();
  expect(branchFromRef(["deadbeef"], ["deadbeef"])).toBe("deadbeef");
  expect(branchFromRef(null, branches)).toBeNull();
});

test("what the panel would refuse is a problem, not a repository", () => {
  expect(problem("")).toBe("empty");
  expect(problem("   ")).toBe("empty");
  expect(problem("https://x-access-token:ghp_abc@github.com/acme/app.git")).toBe("credentials");
  expect(problem("https://oauth2@gitlab.com/group/app.git")).toBe("credentials");
  expect(problem("ghp_abc@github.com/acme/app")).toBe("credentials");
  expect(problem("ssh://git:hunter2@git.example.com/team/app.git")).toBe("credentials");
  expect(problem("http://git.example.com/team/app.git")).toBe("insecure");
  // Three segments and no host: GitLab, Gitea or GitHub? Ask for the host.
  expect(problem("group/sub/repo")).toBe("needsHost");
  expect(problem("ftp://git.example.com/app.git")).toBe("invalid");
  expect(problem("acme / app")).toBe("invalid");
  expect(problem("deploy@git.example.com:team/app.git")).toBe("invalid");
});

test("every URL it gives is one the panel stores", () => {
  const pattern = new RegExp(GitUrl.pattern as string);
  for (const text of [
    "acme/app",
    "gitlab.com/group/sub/repo",
    "git.example.com:3000/team/app",
    "https://git.example.com/team/app.git",
    "ssh://git@git.example.com:2222/team/app.git",
    "git@github.com:acme/app.git",
    "https://github.com/acme/app/tree/dev",
  ]) {
    expect(pattern.test(ok(text).url)).toBe(true);
  }
});
