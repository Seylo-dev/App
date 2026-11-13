// Where the right-click menus are: each list's own row or card element is
// the menu's trigger (no wrapper element, so the layout stays), and the
// Nodes rows get a "..." of their own.

import { expect, test } from "bun:test";
import { auth, nodes, projects, services } from "@seylo/ops";
import { TooltipProvider } from "@seylo/ui/components/tooltip";
import { t } from "../../i18n/t";
import type { NodeRow, Project, ServiceSummary } from "../../lib/types";
import { renderStatic } from "../../test/render";
import { ProjectSections } from "../dashboard/project-sections";
import { ServiceTable } from "../dashboard/service-table";
import { NodeTable } from "../nodes/node-table";
import { ProjectsTree } from "../shell/projects-tree";
import { ShellProvider } from "../shell/shell-context";

const project = (id: string, name: string, serviceCount: number) =>
  ({ id, name, serviceCount, nodeCount: 1, collapsed: false, protected: false, position: null, imageUrl: null }) as unknown as Project;
const service = (id: string, projectId: string, name: string) =>
  ({
    id,
    projectId,
    name,
    parentId: null,
    kind: "app",
    status: "running",
    templateSlug: null,
    protected: false,
    source: { type: "image", label: "nginx:1.30", branch: null, builder: null },
    address: null,
    placements: [{ nodeId: "node1", nodeName: "de-fsn-1", replicas: 1 }],
    cpuPercent: 4,
    memoryBytes: 1024,
    memoryLimitBytes: null,
    liveDeployment: null,
    lastDeployedAt: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  }) as ServiceSummary;

const shop = project("p1", "shop", 1);
const api = service("s1", "p1", "api");

/** The opening tag of the first element whose attributes contain `marker`. */
function tagWith(out: string, marker: string): string {
  const at = out.indexOf(marker);
  if (at < 0) return "";
  return out.slice(out.lastIndexOf("<", at), out.indexOf(">", at) + 1);
}

test("the sidebar: a project's row and each service's link open their menus", async () => {
  const out = await renderStatic(
    () => (
      <ShellProvider>
        <ProjectsTree />
      </ShellProvider>
    ),
    [
      [projects.list, {}, { projects: [shop] }],
      [auth.preferences, {}, { preferences: {} }],
      [services.list, { projectId: "p1" }, { services: [api] }],
    ],
  );
  const link = tagWith(out, 'href="/p/p1/s/s1"');
  expect(link).toStartWith("<a ");
  expect(link).toContain("data-context-menu-trigger");
  expect(link).toContain('data-state="closed"');
  // Selected while its menu is open.
  expect(link).toContain("data-[state=open]:bg-muted");
  const row = tagWith(out, "group/row");
  expect(row).toStartWith("<div ");
  expect(row).toContain("data-context-menu-trigger");
  // The "..." stays, with the name the hide-projects spec looks for.
  expect(out).toContain(`aria-label="${t("sidebar.projectMenu", { name: "shop" })}"`);
  expect(out).toContain('data-project-menu=""');
});

test("the dashboard's cards and table rows open the service's menu", async () => {
  const servicesByProject = new Map([["p1", [api]]]);
  const cards = await renderStatic(() => (
    <ShellProvider>
      <ProjectSections projects={[shop]} services={servicesByProject} hidden={new Set()} onToggle={() => {}} onHiddenChange={() => {}} />
    </ShellProvider>
  ));
  const card = tagWith(cards, 'data-slot="service-card"');
  expect(card).toContain("data-context-menu-trigger");
  expect(card).toContain("data-[state=open]:shadow-popover");
  const table = await renderStatic(() => (
    <ServiceTable projects={[shop]} services={servicesByProject} hidden={new Set()} loading={false} />
  ));
  const row = tagWith(table, "data-context-menu-trigger");
  expect(row).toStartWith("<tr ");
});

test("each node row opens its menu, and has a '...' with the same items", async () => {
  const node = {
    id: "node1",
    name: "de-fsn-1",
    status: "online",
    location: null,
    locationSource: null,
    tags: [],
    isPanelNode: false,
    publicAddress: null,
    publicIpv4: "203.0.113.10",
    publicIpv6: null,
    wildcardDomain: null,
    agentVersion: "0.2.15",
    updateAvailable: false,
    canBuild: true,
    canBuildWarning: null,
    gamesFirstCpu: false,
    wings: { detected: false, version: null, sharedProxy: false },
    usage: null,
    health: { checkedAt: null, worst: null },
    rejectedHello: null,
    lastSeenAt: null,
  } as unknown as NodeRow;
  const out = await renderStatic(
    () => (
      <TooltipProvider>
        <NodeTable onOpen={() => {}} />
      </TooltipProvider>
    ),
    [[nodes.list, {}, { nodes: [node] }]],
  );
  expect(out).toContain(`aria-label="${t("menus.moreFor", { name: "de-fsn-1" })}"`);
  // The table or the stacked list, whichever fits: the node's row is the trigger.
  expect(out).toMatch(/<(tr|li) [^>]*data-context-menu-trigger/);
});
