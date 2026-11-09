import { expect, test } from "bun:test";
import { auth, git } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../i18n/t";
import { type GitCredential, HostKeys, type HostKeysState } from "./add-credential-dialog";
import {
  credentialHost,
  isSshUrl,
  keyscanCommand,
  kindForUrl,
  knownHostsCover,
  knownHostsName,
  looksLikePrivateKey,
  needsKnownHosts,
  providerOf,
  repoLabel,
  validHost,
} from "./credential-host";
import { GitCredentialsCard, missingHostKeys } from "./credentials-card";

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

test("known_hosts names a host with a port as [name]:port, the way ssh-keyscan writes it and the panel matches it", () => {
  expect(knownHostsName("gitea.lan:2222")).toBe("[gitea.lan]:2222");
  expect(knownHostsName("gitea.lan")).toBe("gitea.lan");
  expect(knownHostsName("gitea.lan:22")).toBe("gitea.lan");
  expect(keyscanCommand("gitea.lan:2222")).toBe("ssh-keyscan -p 2222 gitea.lan");
  expect(keyscanCommand("gitlab.com")).toBe("ssh-keyscan gitlab.com");
  expect(keyscanCommand("gitlab.com:22")).toBe("ssh-keyscan gitlab.com");
});

test("pasted known_hosts lines count only when one names the host as the panel matches it", () => {
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample";
  expect(knownHostsCover(`[gitea.lan]:2222 ${key}`, "gitea.lan:2222")).toBe(true);
  // The form the old placeholder showed: the panel never matches it.
  expect(knownHostsCover(`gitea.lan:2222 ${key}`, "gitea.lan:2222")).toBe(false);
  // Port 22 is the plain name, never brackets.
  expect(knownHostsCover(`gitea.lan ${key}`, "gitea.lan:2222")).toBe(false);
  expect(knownHostsCover(`gitea.lan ${key}`, "gitea.lan")).toBe(true);
  expect(knownHostsCover(`[gitea.lan]:22 ${key}`, "gitea.lan")).toBe(false);
  // Several names on one line, and comments and blank lines around it.
  expect(knownHostsCover(`# office\n\n  10.0.0.5,[gitea.lan]:2222 ${key}  \n`, "gitea.lan:2222")).toBe(true);
  expect(knownHostsCover(`# [gitea.lan]:2222 ${key}`, "gitea.lan:2222")).toBe(false);
  // Hashed lines from ~/.ssh/known_hosts name no host.
  expect(knownHostsCover(`|1|F1E1KeoE/eEWhi10WpGv4OdiO6Y=|3988QV0VE8wmZL7suNrYQLITLCg= ${key}`, "gitea.lan")).toBe(false);
  // A name with no key allows nothing.
  expect(knownHostsCover("[gitea.lan]:2222 ssh-ed25519", "gitea.lan:2222")).toBe(false);
  expect(knownHostsCover("", "gitea.lan")).toBe(false);
});

/** HostKeys with the paste box open on `knownHosts`; nothing runs. */
const pasted = (knownHosts: string): HostKeysState => ({
  knownHosts,
  fingerprints: [],
  paste: true,
  scanning: false,
  scanError: null,
  scan: () => {},
  edit: () => {},
  openPaste: () => {},
  clear: () => {},
});

test("the known_hosts box shows the [name]:port form and the command that prints it, and says when no line is for the host", () => {
  const empty = renderToStaticMarkup(<HostKeys host="gitea.lan:2222" keys={pasted("")} />);
  expect(empty).toContain('placeholder="[gitea.lan]:2222 ssh-ed25519 AAAA…"');
  expect(empty).toContain(t("gitCredentials.add.keyscanHint", { command: "ssh-keyscan -p 2222 gitea.lan" }));
  expect(empty).not.toContain(t("gitCredentials.add.knownHostsNoMatch", { name: "[gitea.lan]:2222" }));

  const wrong = renderToStaticMarkup(<HostKeys host="gitea.lan:2222" keys={pasted("gitea.lan:2222 ssh-ed25519 AAAAC3Nz")} />);
  expect(wrong).toContain(t("gitCredentials.add.knownHostsNoMatch", { name: "[gitea.lan]:2222" }));
  expect(wrong).toContain('aria-invalid="true"');

  const right = renderToStaticMarkup(<HostKeys host="gitea.lan:2222" keys={pasted("[gitea.lan]:2222 ssh-ed25519 AAAAC3Nz")} />);
  expect(right).not.toContain(t("gitCredentials.add.knownHostsNoMatch", { name: "[gitea.lan]:2222" }));
  expect(right).toContain('aria-invalid="false"');
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
  credential({
    id: "cred000000000004",
    name: "office gitea key",
    kind: "ssh_key",
    host: "gitea.lan:2222",
    username: null,
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample office gitea key",
    fingerprint: "SHA256:def",
    knownHosts: "[gitea.lan]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKey",
  }),
  // GitHub's host keys are built into the panel: none are needed.
  credential({
    id: "cred000000000005",
    name: "github deploy key",
    kind: "ssh_key",
    host: "github.com",
    username: null,
    origin: "generated",
  }),
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

test("owners and admins list git credentials with their kind, user name and use, and can edit and delete them", async () => {
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
    // Edit and Delete on the token and the three SSH keys; the GitHub account has neither (next test).
    expect(buttons(out, t("gitCredentials.list.edit"))).toBe(4);
    expect(buttons(out, t("gitCredentials.list.delete"))).toBe(4);
  }
});

test("an SSH key with no host keys for its host is marked, so it can be fixed with Edit", async () => {
  // Only the gitea deploy key: the office key has its line, GitHub needs none, tokens have no host keys.
  expect(items.filter(missingHostKeys).map((c) => c.name)).toEqual(["gitea deploy key"]);
  // Lines that name the host the wrong way are as good as none.
  expect(missingHostKeys(credential({ kind: "ssh_key", host: "gitea.lan:2222", knownHosts: "gitea.lan:2222 ssh-ed25519 AAAA" }))).toBe(
    true,
  );
  const out = await render("owner", <GitCredentialsCard />);
  expect(out.split(`>${t("gitCredentials.list.hostKeysMissing")}</span>`).length - 1).toBe(1);
});

test("the GitHub account from the device flow is managed on Settings > GitHub, not renamed or deleted here", async () => {
  const out = await render("owner", <GitCredentialsCard />);
  expect(out).toContain(t("gitCredentials.list.githubAccount"));
  expect(out).toMatch(new RegExp(`<a [^>]*href="/settings/github"[^>]*>${t("gitCredentials.list.onGithubPage")}</a>`));
});

test("members, who cannot manage git credentials (git.manage), get no card", async () => {
  expect(await render("member", <GitCredentialsCard />)).toBe("");
});
