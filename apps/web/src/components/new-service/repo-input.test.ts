import { expect, test } from "bun:test";
import { GitUrl } from "@seylo/ops";
import { parseRepoInput, type RepoRef } from "./repo-input";

const ok = (text: string): RepoRef => {
  const parsed = parseRepoInput(text);
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
    branch: null,
  });
  expect(ok("  acme/app.git  ")).toEqual(ok("acme/app"));
  expect(ok("Acme-Labs/my.site_v2").url).toBe("https://github.com/Acme-Labs/my.site_v2.git");
  // GitHub owners have no dots or underscores: those are hosts or nothing.
  expect(problem("acme_labs/app")).toBe("invalid");
  expect(problem("acme/..")).toBe("invalid");
  expect(problem("acme")).toBe("invalid");
});

test("a host and path without a scheme is an https repository", () => {
  expect(ok("github.com/acme/app")).toEqual(ok("acme/app"));
  expect(ok("github.com/acme/app.git/")).toEqual(ok("acme/app"));
  expect(ok("gitlab.com/group/sub/repo")).toEqual({
    url: "https://gitlab.com/group/sub/repo.git",
    host: "gitlab.com",
    path: "group/sub/repo",
    ssh: false,
    branch: null,
  });
  expect(ok("bitbucket.org/acme/app").url).toBe("https://bitbucket.org/acme/app.git");
  // Other hosts keep the path as written: some serve repositories without .git only.
  expect(ok("git.example.com:3000/team/app")).toEqual({
    url: "https://git.example.com:3000/team/app",
    host: "git.example.com:3000",
    path: "team/app",
    ssh: false,
    branch: null,
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
    branch: null,
  });
  expect(ok("https://dev.azure.com/acme/shop/_git/api").url).toBe("https://dev.azure.com/acme/shop/_git/api");
  expect(ok("https://github.com/acme/app").url).toBe("https://github.com/acme/app.git");
  expect(ok("HTTPS://GitHub.com/acme/app.git")).toEqual(ok("acme/app"));
  expect(ok("ssh://git@git.example.com:2222/team/app.git")).toEqual({
    url: "ssh://git@git.example.com:2222/team/app.git",
    host: "git.example.com:2222",
    path: "team/app",
    ssh: true,
    branch: null,
  });
  expect(ok("git@github.com:acme/app.git")).toEqual({
    url: "git@github.com:acme/app.git",
    host: "github.com",
    path: "acme/app",
    ssh: true,
    branch: null,
  });
  expect(ok("git@gitlab.com:group/sub/repo.git").path).toBe("group/sub/repo");
});

test("page addresses of well-known hosts give the repository and the branch", () => {
  expect(ok("https://github.com/acme/app/tree/feat/queue")).toMatchObject({ url: "https://github.com/acme/app.git", branch: "feat/queue" });
  expect(ok("github.com/acme/app/blob/main/README.md")).toMatchObject({ path: "acme/app", branch: null });
  expect(ok("https://github.com/acme/app?tab=readme#install").url).toBe("https://github.com/acme/app.git");
  expect(ok("https://gitlab.com/group/sub/repo/-/tree/dev")).toMatchObject({ path: "group/sub/repo", branch: "dev" });
  expect(ok("https://bitbucket.org/acme/app/src/release/")).toMatchObject({ path: "acme/app", branch: "release" });
  expect(ok("https://codeberg.org/acme/app/src/branch/next")).toMatchObject({ path: "acme/app", branch: "next" });
  expect(problem("https://github.com/acme")).toBe("invalid");
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
