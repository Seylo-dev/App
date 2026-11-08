import { expect, test } from "bun:test";
import { auth, git, OpError, projects } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../i18n/t";
import type { ServiceDetail } from "../service/use-service";
import { DeployHostAction, InternalGitHosts, InternalHostNote } from "./internal-hosts";

const projectId = "prj1prj1prj1prj1";

function render(role: "owner" | "admin" | "member", node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  queryClient.setQueryData(opQueryKey(auth.whoami, {}), {
    viewer: { id: "u1", email: "a@example.com", name: "Ada", role },
    via: "session",
  });
  queryClient.setQueryData(opQueryKey(projects.get, { projectId }), { id: projectId, name: "shop" });
  queryClient.setQueryData(opQueryKey(git.listInternalHosts, { projectId }), {
    items: [
      { host: "git.example.com", approvedBy: { id: "u1", name: "Ada" }, createdAt: "2026-11-01T10:00:00.000Z", usedBy: 2 },
      { host: "10.0.0.7:3000", approvedBy: null, createdAt: "2026-11-01T10:00:00.000Z", usedBy: 0 },
    ],
  });
  // No request leaves the test: the answers are in the cache already.
  const client = { call: () => new Promise(() => {}) } as unknown as OpClient;
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <OpClientProvider client={client}>{node}</OpClientProvider>
    </QueryClientProvider>,
  );
}

/** How renderToStaticMarkup writes text. */
const html = (text: string) => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");

const refused = new OpError("BAD_REQUEST", "git.example.com is an address of one of this panel's nodes (51.15.20.30).", {
  field: "source.url",
  reason: "internalTarget",
  host: "git.example.com",
});
const note = (error: unknown) => <InternalHostNote error={error} projectId={projectId} url="https://git.example.com/me/app.git" />;

test("an admin refused for an internal git host is offered to allow it for the project", () => {
  const out = render("admin", note(refused));
  expect(out).toContain(html(t("gitHosts.note.allow", { project: "shop" })));
  expect(out).toContain(html(t("gitHosts.note.admin", { host: "git.example.com" })));
});

test("a member refused for an internal git host is told who can allow it", () => {
  const out = render("member", note(refused));
  expect(out).toContain(html(t("gitHosts.note.askAdmin", { host: "git.example.com", project: "shop" })));
  expect(out).not.toContain(html(t("gitHosts.note.allow", { project: "shop" })));
});

test("no note for a metadata address or another error", () => {
  const metadata = new OpError("BAD_REQUEST", "169.254.169.254 is a cloud metadata endpoint; nodes never clone from it.", {
    field: "source.url",
    reason: "internalTarget",
  });
  expect(render("owner", note(metadata))).toBe("");
  expect(render("owner", note(new OpError("FORBIDDEN", "No.")))).toBe("");
  expect(render("owner", note(null))).toBe("");
});

test("admins see the project's internal git hosts; members see nothing", () => {
  const out = render("owner", <InternalGitHosts projectId={projectId} projectName="shop" />);
  expect(out).toContain(html(t("gitHosts.list.title")));
  expect(out).toContain("git.example.com");
  expect(out).toContain("10.0.0.7:3000");
  expect(out).toContain(html(t("gitHosts.list.recorded")));
  expect(out).toContain(html(t("gitHosts.list.usedBy", { count: 2 })));
  expect(out).toContain(html(t("gitHosts.add.submit")));
  expect(render("member", <InternalGitHosts projectId={projectId} projectName="shop" />)).toBe("");
});

test("a deployment the node refused for its git host offers admins to allow it", () => {
  const service = {
    id: "svc1svc1svc1svc1",
    projectId,
    sourceConfig: { type: "git", url: "https://git.example.com/me/app.git", branch: "main", credentialId: null, deployOnPush: false },
  } as unknown as ServiceDetail;
  const nodeRefused =
    "fetching the source failed: the node refused to connect to git.example.com:443: 51.15.20.30 is an address of this node. Nodes clone only from public addresses other than their own; an admin can allow internal addresses of this host for the project (the project's Settings > Internal git hosts, or git.allowInternalHost)";
  expect(render("admin", <DeployHostAction service={service} error={nodeRefused} />)).toContain(
    html(t("gitHosts.note.allow", { project: "shop" })),
  );
  expect(render("admin", <DeployHostAction service={service} error="Build failed: npm ERR!" />)).toBe("");
  expect(render("member", <DeployHostAction service={service} error={nodeRefused} />)).toBe("");
});
