import { expect, test } from "bun:test";
import { projects, services, system } from "@seylo/ops";
import type { ComponentType } from "react";
import { t } from "../../i18n/t";
import { Route } from "../../routes/_app/index";
import { renderStatic } from "../../test/render";
import { ShellProvider } from "../shell/shell-context";

const Dashboard = Route.options.component as ComponentType;
const render = (answers: Parameters<typeof renderStatic>[1] = []) =>
  renderStatic(
    () => (
      <ShellProvider>
        <Dashboard />
      </ShellProvider>
    ),
    answers,
  );

/** What the dashboard and the palette read of a service. */
const summary = (id: string, name: string) => ({
  id,
  name,
  projectId: "p1",
  parentId: null,
  kind: "app",
  status: "running",
  templateSlug: null,
  protected: false,
  source: { type: "image", label: "nginx:1.30", branch: null, builder: null },
  placements: [],
  cpuPercent: null,
  memoryBytes: null,
  liveDeployment: null,
});

/** The page header's subtitle, as markup. */
const subtitle = (out: string) => {
  const start = out.indexOf("</h1>");
  return out.slice(start, out.indexOf("</div>", start));
};

test("the dashboard subtitle is a placeholder, not '0 projects', while the lists load", async () => {
  const pending = subtitle(await render());
  expect(pending).not.toContain(t("dashboard.projectCount", { count: 0 }));
  expect(pending).toContain('data-slot="skeleton"');

  // Projects are in but their services are not: still a placeholder, not "1 project" turning into "2 services".
  const halfway = subtitle(
    await render([
      [system.info, {}, { nodes: { total: 2, online: 2 } }],
      [projects.list, {}, { projects: [{ id: "p1", name: "shop" }] }],
    ]),
  );
  expect(halfway).not.toContain(t("dashboard.projectCount", { count: 1 }));
  expect(halfway).toContain('data-slot="skeleton"');
});

test("the dashboard subtitle counts nodes and services once they are in", async () => {
  const out = subtitle(
    await render([
      [system.info, {}, { nodes: { total: 2, online: 2 } }],
      [projects.list, {}, { projects: [{ id: "p1", name: "shop" }] }],
      [services.list, { projectId: "p1" }, { services: [summary("s1", "api"), summary("s2", "web")] }],
    ]),
  );
  expect(out).toContain([t("dashboard.nodeCount", { count: 2 }), t("sidebar.serviceCount", { count: 2 })].join(t("format.separator")));
  expect(out).not.toContain('data-slot="skeleton"');
});
