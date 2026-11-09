import { expect, test } from "bun:test";
import { auth, git } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../i18n/t";
import type { GitCredential } from "./add-credential-dialog";
import {
  credentialHost,
  isSshUrl,
  kindForUrl,
  looksLikePrivateKey,
  needsKnownHosts,
  providerOf,
  repoLabel,
  validHost,
} from "./credential-host";
import { GitCredentialsCard } from "./credentials-card";

test("the credential host is the URL's host as the panel records it (urlHost)", () => {
  expect(credentialHost("https://GitLab.com/acme/shop.git")).toBe("gitlab.com");
  expect(credentialHost("https://git.example.com:8443/acme/shop.git")).toBe("git.example.com:8443");
  // The default port is no part of the host, as with new URL(url).host on the panel.
  expect(credentialHost("https://git.example.com:443/acme/shop.git")).toBe("git.example.com");
  expect(credentialHost("git@github.com:acme/shop.git")).toBe("github.com");
  expect(credentialHost("ssh://git@gitea.lan:2222/acme/shop.git")).toBe("gitea.lan:2222");
  expect(credentialHost("ssh://git@gitea.lan:22/acme/shop.git")).toBe("gitea.lan");
  expect(credentialHost("ssh://gitea.lan/acme/shop.git")).toBe("gitea.lan");
  expect(credentialHost("")).toBeNull();
  expect(credentialHost("http://git.example.com/acme/shop.git")).toBeNull();
  expect(credentialHost("not a url")).toBeNull();
});

test("SSH URLs need an SSH key, https:// URLs a token", () => {
  expect(isSshUrl("git@github.com:acme/shop.git")).toBe(true);
  expect(isSshUrl("ssh://git@gitea.lan:2222/acme/shop.git")).toBe(true);
  expect(isSshUrl("https://github.com/acme/shop.git")).toBe(false);
  expect(kindForUrl("git@gitlab.com:acme/shop.git")).toBe("ssh_key");
  expect(kindForUrl("https://gitlab.com/acme/shop.git")).toBe("token");
  // No URL yet (Settings): a token, the usual case.
  expect(kindForUrl("")).toBe("token");
});

test("a new credential is named after the repository", () => {
  expect(repoLabel("https://gitlab.com/acme/platform/shop.git")).toBe("platform/shop");
  expect(repoLabel("git@github.com:acme/shop-api.git")).toBe("acme/shop-api");
  expect(repoLabel("ssh://git@gitea.lan:2222/team/app")).toBe("team/app");
  expect(repoLabel("")).toBe("");
  expect(repoLabel(`https://git.example.com/acme/${"x".repeat(80)}.git`).length).toBe(60);
});

test("hosts: what the ops take, whose wording the hints use, and which need host keys", () => {
  expect(validHost("git.example.com:2222")).toBe(true);
  expect(validHost("git example.com")).toBe(false);
  expect(validHost("")).toBe(false);
  expect(providerOf("github.com")).toBe("github");
  expect(providerOf("gitlab.com")).toBe("gitlab");
  expect(providerOf("gitlab.acme.dev:8443")).toBe("gitlab");
  expect(providerOf("bitbucket.org")).toBe("bitbucket");
  expect(providerOf("gitea.lan")).toBe("other");
  // Only GitHub's host keys are built into the panel.
  expect(needsKnownHosts("github.com")).toBe(false);
  expect(needsKnownHosts("gitlab.com")).toBe(true);
  expect(needsKnownHosts("ssh.github.com:443")).toBe(true);
  expect(looksLikePrivateKey("  -----BEGIN OPENSSH PRIVATE KEY-----\nabc")).toBe(true);
  expect(looksLikePrivateKey("ssh-ed25519 AAAA")).toBe(false);
});

const at = "2026-11-01T10:00:00.000Z";
const credential = (over: Partial<GitCredential>): GitCredential => ({
  id: "cred000000000001",
  name: "shop token",
  kind: "token",
  host: "gitlab.com",
  username: "git",
  publicKey: null,
  fingerprint: null,
  knownHosts: "",
  origin: "manual",
  usedBy: 0,
  createdAt: at,
  updatedAt: at,
  ...over,
});

const items = [
  credential({ usedBy: 2 }),
  credential({
    id: "cred000000000002",
    name: "gitea deploy key",
    kind: "ssh_key",
    host: "gitea.lan:2222",
    username: null,
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample gitea deploy key",
    fingerprint: "SHA256:abc",
    origin: "generated",
  }),
  credential({ id: "cred000000000003", name: "GitHub (acme-ops)", host: "github.com", username: "acme-ops", origin: "device", usedBy: 1 }),
];

/** Renders inside a router (rows link to Settings > GitHub) with whoami and git.listCredentials in the cache. */
async function render(role: "owner" | "admin" | "member", node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  queryClient.setQueryData(opQueryKey(auth.whoami, {}), {
    viewer: { id: "u1", email: "a@example.com", name: "Ada", role },
    via: "session",
  });
  queryClient.setQueryData(opQueryKey(git.listCredentials, {}), { items });
  // No request leaves the test: the answers are in the cache already.
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

/** How many buttons say exactly `label`. */
const buttons = (out: string, label: string) => out.split(`>${label}</button>`).length - 1;

test("owners and admins list git credentials with their kind, user name and use, and can rename and delete them", async () => {
  for (const role of ["owner", "admin"] as const) {
    const out = await render(role, <GitCredentialsCard />);
    expect(out).toContain('id="git-credentials"');
    expect(out).toContain(t("gitCredentials.list.title"));
    expect(out).toContain(t("gitCredentials.list.add"));
    expect(out).toContain("shop token");
    expect(out).toContain(t("gitCredentials.kinds.ssh_key"));
    expect(out).toContain("gitea.lan:2222");
    expect(out).toContain(t("gitCredentials.list.usedBy", { count: 2 }));
    expect(out).toContain(t("gitCredentials.list.unused"));
    // Rename and Delete on the token and the deploy key; the GitHub account has neither (next test).
    expect(buttons(out, t("gitCredentials.list.rename"))).toBe(2);
    expect(buttons(out, t("gitCredentials.list.delete"))).toBe(2);
  }
});

test("the GitHub account from the device flow is managed on Settings > GitHub, not renamed or deleted here", async () => {
  const out = await render("owner", <GitCredentialsCard />);
  expect(out).toContain(t("gitCredentials.list.githubAccount"));
  expect(out).toMatch(new RegExp(`<a [^>]*href="/settings/github"[^>]*>${t("gitCredentials.list.onGithubPage")}</a>`));
});

test("members, who cannot manage git credentials (git.manage), get no card", async () => {
  expect(await render("member", <GitCredentialsCard />)).toBe("");
});
