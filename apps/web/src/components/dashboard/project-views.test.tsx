import { expect, test } from "bun:test";
import { nodes } from "@seylo/ops";
import { t } from "../../i18n/t";
import type { Project, ServiceSummary } from "../../lib/types";
import { renderStatic } from "../../test/render";
import { ShellProvider } from "../shell/shell-context";
import { ProjectSections } from "./project-sections";
import { ServiceTable } from "./service-table";

const project = (id: string, name: string, serviceCount: number, extra: Partial<Project> = {}) =>
  ({ id, name, serviceCount, nodeCount: 1, collapsed: false, protected: false, ...extra }) as Project;

const service = (id: string, projectId: string, name: string, extra: Partial<ServiceSummary> = {}) =>
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
    memoryBytes: 182 * 1024 * 1024,
    memoryLimitBytes: null,
    liveDeployment: null,
    lastDeployedAt: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...extra,
  }) as ServiceSummary;

const shop = project("p1", "shop", 2);
const blog = project("p2", "blog", 1);
const nodeAnswer = [nodes.list, {}, { nodes: [{ id: "node1", facts: { memoryTotalBytes: 4 * 1024 ** 3 } }] }] as const;

test("the table lists every service by project, then name, with sortable headers", async () => {
  const services = new Map([
    ["p1", [service("s2", "p1", "web"), service("s1", "p1", "api", { status: "crashed", cpuPercent: null, memoryBytes: null })]],
    ["p2", [service("s3", "p2", "blog")]],
  ]);
  const out = await renderStatic(
    () => <ServiceTable projects={[shop, blog]} services={services} hidden={new Set(["p2"])} loading={false} />,
    [[...nodeAnswer]],
  );
  // Seven sortable columns, none sorted yet.
  expect(out.match(/aria-sort="none"/g)?.length).toBe(7);
  for (const column of ["service", "project", "status", "cpu", "memory", "node", "lastDeploy"] as const)
    expect(out).toContain(t(`dashboard.table.${column}`));
  // shop's services by name, then blog's.
  const order = ["api", "web", "blog"].map((name) => out.indexOf(`>${name}</a>`));
  expect(order.every((at) => at > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // Each row links to its service; the stopped one shows "-" for usage (none deployed yet), and the hidden project says so.
  expect(out).toContain('href="/p/p1/s/s1"');
  expect(out).toContain(t("project.status.crashed"));
  expect(out).toContain(">-</span>");
  expect(out).toContain(t("dashboard.hiddenChip"));
  expect(out).not.toContain('data-slot="skeleton"');
});

test("the table holds a placeholder row per service of a project still loading, and says when there is nothing", async () => {
  const loadingOut = await renderStatic(() => (
    <ServiceTable projects={[shop, blog]} services={new Map([["p2", [service("s3", "p2", "blog")]]])} hidden={new Set()} loading={false} />
  ));
  // shop's two services are on their way.
  expect(loadingOut).toContain('aria-busy="true"');
  expect(loadingOut.match(/<tr>/g)?.length).toBe(2);
  const empty = await renderStatic(() => (
    <ServiceTable projects={[project("p3", "new", 0)]} services={new Map([["p3", []]])} hidden={new Set()} loading={false} />
  ));
  expect(empty).toContain(t("dashboard.table.noServices"));
});

test("the cards view shows each project's services as compact cards with their status and bars", async () => {
  const services = new Map([["p1", [service("s1", "p1", "api"), service("s2", "p1", "web", { status: "building", cpuPercent: null })]]]);
  const out = await renderStatic(
    () => (
      <ShellProvider>
        <ProjectSections
          projects={[shop, project("p3", "empty", 0), project("p4", "folded", 3, { collapsed: true })]}
          services={services}
          hidden={new Set()}
          onToggle={() => {}}
          onHiddenChange={() => {}}
        />
      </ShellProvider>
    ),
    [[...nodeAnswer]],
  );
  expect(out.match(/data-slot="service-card"/g)?.length).toBe(2);
  expect(out).toContain(t("project.status.running"));
  expect(out).toContain(t("project.status.building"));
  expect(out).toContain(`${t("dashboard.cpu")}</span>`);
  expect(out).toContain(`${t("dashboard.memory")}</span>`);
  // The title row's actions: open, settings and + for the project.
  expect(out).toContain(t("dashboard.openProject", { name: "shop" }));
  expect(out).toContain('href="/p/p1?tab=settings"');
  expect(out).toContain(t("sidebar.newServiceIn", { name: "shop" }));
  // An empty project offers its first service; a collapsed one is only its title row.
  expect(out).toContain(t("project.addService"));
  expect(out).toContain(t("sidebar.expand", { name: "folded" }));
  expect(out).not.toContain('data-slot="skeleton"');
});
