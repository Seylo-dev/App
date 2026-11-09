import { expect, test } from "bun:test";
import { renderStatic } from "../../test/render";
import type { Deployment } from "./deploy-steps";
import { gitUrlHost, PrivateRepoHint, privateRepoProvider } from "./private-repo-hint";
import type { ServiceDetail } from "./use-service";

const cloneFailed = {
  status: "failed" as const,
  error: "fetching the source failed: could not fetch main - check the address, the branch and the credentials (exit status 128)",
  steps: [
    { key: "clone", status: "failed", node: null, detail: "could not fetch main (exit status 128)", durationMs: 900 },
    { key: "build", status: "pending", node: null, detail: "", durationMs: null },
  ] as Deployment["steps"],
};

const git = (url: string, credentialId: string | null = null) =>
  ({ type: "git", url, branch: "main", credentialId, deployOnPush: false }) as ServiceDetail["sourceConfig"];

test("a failed clone of a plain git URL on GitHub, GitLab or Bitbucket with no credential names the provider", () => {
  expect(privateRepoProvider(cloneFailed, git("https://github.com/acme/private-api.git"))).toBe("github");
  expect(privateRepoProvider(cloneFailed, git("git@gitlab.com:acme/private-api.git"))).toBe("gitlab");
  expect(privateRepoProvider(cloneFailed, git("ssh://git@bitbucket.org/acme/private-api.git"))).toBe("bitbucket");
  expect(privateRepoProvider(cloneFailed, git("https://www.github.com/acme/private-api"))).toBe("github");
  // Git's exit code alone is enough, without the agent's wording.
  const exitOnly = {
    ...cloneFailed,
    error: "git fetch: exit code 128",
    steps: [{ ...cloneFailed.steps[0], detail: "" }],
  } as typeof cloneFailed;
  expect(privateRepoProvider(exitOnly, git("https://github.com/acme/private-api"))).toBe("github");
});

test("no hint where it would not help", () => {
  const url = "https://github.com/acme/private-api.git";
  // A credential is set: the credential is wrong, not missing.
  expect(privateRepoProvider(cloneFailed, git(url, "cred000000000001"))).toBeNull();
  // Another host: there is no connection to point at.
  expect(privateRepoProvider(cloneFailed, git("https://git.example.com/acme/api.git"))).toBeNull();
  // Not a plain git URL (GitHub App, provider, image).
  expect(
    privateRepoProvider(cloneFailed, { type: "github", installationId: "i1", repo: "acme/api", branch: "main", deployOnPush: true }),
  ).toBeNull();
  // Failed later than the clone, or for another reason.
  const buildFailed = {
    ...cloneFailed,
    steps: [
      { ...cloneFailed.steps[0], status: "ok" },
      { ...cloneFailed.steps[1], status: "failed" },
    ],
  } as typeof cloneFailed;
  expect(privateRepoProvider(buildFailed, git(url))).toBeNull();
  const otherError = {
    ...cloneFailed,
    error: "No node can build.",
    steps: [{ ...cloneFailed.steps[0], detail: "Fetching source" }],
  } as typeof cloneFailed;
  expect(privateRepoProvider(otherError, git(url))).toBeNull();
  expect(privateRepoProvider({ ...cloneFailed, status: "live" as never }, git(url))).toBeNull();
});

test("git URL hosts in every form", () => {
  expect(gitUrlHost("https://github.com/acme/api.git")).toBe("github.com");
  expect(gitUrlHost("https://token@GitHub.com/acme/api")).toBe("github.com");
  expect(gitUrlHost("git@gitlab.com:acme/api.git")).toBe("gitlab.com");
  expect(gitUrlHost("ssh://git@bitbucket.org:22/acme/api.git")).toBe("bitbucket.org");
  expect(gitUrlHost("not a url")).toBeNull();
});

test("the hint links to the Source tab", async () => {
  const service = {
    id: "svc-api",
    projectId: "prj-shop",
    sourceConfig: git("https://github.com/acme/private-api.git"),
  } as ServiceDetail;
  const out = await renderStatic(() => <PrivateRepoHint service={service} d={cloneFailed} />);
  expect(out).toContain("If the repository is private, connect it through GitHub on the ");
  expect(out).toMatch(/<a [^>]*href="\/p\/prj-shop\/s\/svc-api\/source"[^>]*>Source tab<\/a>/);
  expect(out).toContain(", or pick a git credential there.");
  const none = await renderStatic(() => <PrivateRepoHint service={service} d={{ ...cloneFailed, status: "cancelled" }} />);
  expect(none).not.toContain("private");
});
