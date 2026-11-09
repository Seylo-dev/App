import { expect, test } from "bun:test";
import { auth, git } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../../i18n/t";
import type { GitCredential } from "../../git/add-credential-dialog";
import type { ServiceDetail } from "../use-service";
import { GitForm } from "./git-form";

// Only what GitForm reads.
const serviceWith = (credentialId: string | null) =>
  ({
    id: "svc-1",
    projectId: "prj-1",
    sourceConfig: { type: "git", url: "https://gitlab.com/acme/shop.git", branch: "main", credentialId, deployOnPush: false },
  }) as unknown as ServiceDetail;

const at = "2026-11-01T10:00:00.000Z";
const shopToken: GitCredential = {
  id: "cred000000000001",
  name: "shop token",
  kind: "token",
  host: "gitlab.com",
  username: "git",
  publicKey: null,
  fingerprint: null,
  knownHosts: "",
  origin: "manual",
  usedBy: 1,
  createdAt: at,
  updatedAt: at,
};

async function render(
  role: "owner" | "admin" | "member",
  { credentialId = null, items = [] }: { credentialId?: string | null; items?: GitCredential[] } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  queryClient.setQueryData(opQueryKey(auth.whoami, {}), {
    viewer: { id: "u1", email: "a@example.com", name: "Ada", role },
    via: "session",
  });
  queryClient.setQueryData(opQueryKey(git.listCredentials, {}), { items });
  // No request leaves the test: the answers are in the cache already.
  const client = { call: () => new Promise(() => {}) } as unknown as OpClient;
  const service = serviceWith(credentialId);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <GitForm service={service} /> }),
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

/** Whether the button labelled `label` is disabled. */
function disabled(out: string, label: string): boolean {
  const button = new RegExp(`<button[^>]*>${label}</button>`).exec(out)?.[0];
  expect(button).toBeDefined();
  return / disabled=""/.test(button ?? "");
}

test("owners and admins can add a credential next to the picker and manage them on Settings > Git providers", async () => {
  for (const role of ["owner", "admin"] as const) {
    const out = await render(role);
    expect(out).toContain(t("gitCredentials.add.open"));
    expect(out).toContain('href="/settings/git-providers#git-credentials"');
    expect(out).toContain(t("serviceSource.git.manageCredentials"));
    // Before: the link went to Settings > GitHub, where no git credential can be added.
    expect(out).not.toContain('href="/settings/github"');
  }
});

test("members, who cannot create git credentials (git.manage), get the picker only", async () => {
  const out = await render("member");
  expect(out).toContain(`aria-label="${t("serviceSource.git.credential")}"`);
  expect(out).not.toContain(t("gitCredentials.add.open"));
  expect(out).not.toContain(t("serviceSource.git.manageCredentials"));
});

test("a picked credential that is no longer listed is named as deleted, and Check access and Save wait for another pick", async () => {
  const gone = await render("member", { credentialId: "cred000000000009", items: [shopToken] });
  expect(gone).toContain(t("gitCredentials.picker.deletedNote"));
  expect(gone).toContain('aria-describedby="git-credential-gone"');
  expect(disabled(gone, t("service.save"))).toBe(true);
  expect(disabled(gone, t("serviceSource.git.check"))).toBe(true);

  const listed = await render("member", { credentialId: shopToken.id, items: [shopToken] });
  expect(listed).not.toContain(t("gitCredentials.picker.deletedNote"));
  expect(disabled(listed, t("service.save"))).toBe(false);
  expect(disabled(listed, t("serviceSource.git.check"))).toBe(false);
});
