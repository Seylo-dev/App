import { expect, test } from "bun:test";
import { auth } from "@seylo/ops";
import { type Answer, renderStatic } from "../../test/render";
import type { Deployment } from "./deploy-steps";
import { CloneNetworkHint, cloneNetworkFailure, gitUrlHost, PrivateRepoHint, privateRepoProvider } from "./private-repo-hint";
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

// What the agent says for a clone that failed on the node's network (build.GitNetworkError): the incident's
// "CONNECT tunnel failed, response 502", with the connection the node could not make.
const networkError =
  "fetching the source failed: node de-fsn-1 could not connect to github.com:443 - a network problem on the node, not the address, " +
  "the branch or the credentials: dial tcp 140.82.121.4:443: i/o timeout (git exited with code 128). " +
  "The node's Health check (its Health tab, or `seylo health` on the node) tests its DNS and connections";
const de = { id: "nodedefsn1000001", name: "de-fsn-1" };
const cloneNetwork = {
  status: "failed" as const,
  error: `The build failed: ${networkError}`,
  builtOn: de,
  steps: [
    { key: "clone", status: "failed", node: de, detail: networkError, durationMs: 30_400 },
    { key: "build", status: "pending", node: de, detail: "", durationMs: null },
  ] as Deployment["steps"],
};

const viewer = (role: "owner" | "admin" | "member"): Answer => [
  auth.whoami,
  {},
  { viewer: { id: "u1", email: "you@example.com", name: "You", role }, via: "session" },
];

test("a clone that failed on the node's network: no private-repo hint, the node's Health check instead", async () => {
  expect(cloneNetworkFailure(cloneNetwork)).toBe("network");
  expect(privateRepoProvider(cloneNetwork, git("https://github.com/acme/private-api.git"))).toBeNull();
  for (const role of ["owner", "admin"] as const) {
    const out = await renderStatic(() => <CloneNetworkHint d={cloneNetwork} />, [viewer(role)]);
    expect(out).toContain('data-slot="clone-network-hint"');
    expect(out).toContain("A network problem on de-fsn-1 stopped the clone, not the repository&#x27;s address or credentials. Its ");
    expect(out).toMatch(/<a [^>]*href="\/nodes\?node=nodedefsn1000001&amp;view=health"[^>]*>Health check<\/a>/);
    expect(out).toContain(" tests the node&#x27;s DNS and connections.");
  }
  // A member does not see the Nodes page: no link.
  const member = await renderStatic(() => <CloneNetworkHint d={cloneNetwork} />, [viewer("member")]);
  expect(member).toContain(
    "A network problem on de-fsn-1 stopped the clone, not the repository&#x27;s address or credentials. An admin can run the node&#x27;s Health check.",
  );
  expect(member).not.toContain("<a ");
});

test("the network hint shows only for a clone that failed on the network", async () => {
  // The private-repo case and every other failure keep their own hint, or none.
  expect(cloneNetworkFailure(cloneFailed)).toBeNull();
  const privateOut = await renderStatic(() => <CloneNetworkHint d={{ ...cloneFailed, builtOn: de }} />, [viewer("owner")]);
  expect(privateOut).not.toContain("clone-network-hint");
  const built = {
    ...cloneNetwork,
    steps: [
      { ...cloneNetwork.steps[0], status: "ok" },
      { ...cloneNetwork.steps[1], status: "failed" },
    ],
  } as typeof cloneNetwork;
  expect(cloneNetworkFailure(built)).toBeNull();
  expect(cloneNetworkFailure({ ...cloneNetwork, status: "cancelled" as never })).toBeNull();
});

// A name that does not exist or a refused connection (GitNetworkError.MaybeAddress): a mistyped host or a wrong
// port gives it as well, so the agent asks to check the address first, and so does the hint, never "not the
// repository's address".
const typoError =
  "fetching the source failed: node de-fsn-1 could not resolve gihub.com - check the address: dial tcp: lookup gihub.com: no such host " +
  "(git exited with code 128). If the address is right, the node's Health check (its Health tab, or `seylo health` on the node) tests its DNS and connections";
const refusedError =
  "fetching the source failed: node de-fsn-1 could not connect to github.com:443 - check the address: dial tcp 140.82.121.4:443: connect: connection refused " +
  "(git exited with code 128). If the address is right, the node's Health check (its Health tab, or `seylo health` on the node) tests its DNS and connections";
const failedWith = (message: string) => ({
  ...cloneNetwork,
  error: `The build failed: ${message}`,
  steps: cloneNetwork.steps.map((s) => (s.key === "clone" ? { ...s, detail: message } : s)),
});

test("a clone a wrong address may have failed: check the address, then the node's Health check", async () => {
  for (const message of [typoError, refusedError]) {
    const d = failedWith(message);
    expect(cloneNetworkFailure(d)).toBe("address");
    // A refused connection to github.com is no private repository either.
    expect(privateRepoProvider(d, git("https://github.com/acme/private-api.git"))).toBeNull();
    const out = await renderStatic(() => <CloneNetworkHint d={d} />, [viewer("owner")]);
    expect(out).toContain('data-slot="clone-network-hint"');
    expect(out).toContain(
      "The clone could not reach the repository&#x27;s host from de-fsn-1. Check the address; if it is right, the node&#x27;s ",
    );
    expect(out).toMatch(/<a [^>]*href="\/nodes\?node=nodedefsn1000001&amp;view=health"[^>]*>Health check<\/a>/);
    expect(out).toContain(" tests its DNS and connections.");
    expect(out).not.toContain("not the repository");
    const member = await renderStatic(() => <CloneNetworkHint d={d} />, [viewer("member")]);
    expect(member).toContain(
      "The clone could not reach the repository&#x27;s host from de-fsn-1. Check the address; if it is right, an admin can run the node&#x27;s Health check.",
    );
    expect(member).not.toContain("<a ");
  }
});
