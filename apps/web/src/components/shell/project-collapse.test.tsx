// The sidebar and the home page fold a project each by their own flag
// (Project.collapsed and Project.dashboardCollapsed, 0.2.16 owner request:
// the home page all open, the sidebar with some folded). Until the projects
// load, each view's placeholders take the shape it last had in this browser
// for this person (lib/projects-shape.ts); once they load, the panel's flags
// win. Blocked storage draws the usual placeholders.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth, projects } from "@seylo/ops";
import { t } from "../../i18n/t";
import { dashboardViewStorage } from "../../lib/dashboard-view";
import { projectsShapeStorage } from "../../lib/projects-shape";
import type { Project } from "../../lib/types";
import type { ServicesByProject } from "../../lib/use-all-services";
import { type Answer, renderStatic } from "../../test/render";
import { ProjectCards } from "../dashboard/project-cards";
import { ProjectsTree } from "./projects-tree";
import { ShellProvider } from "./shell-context";

const project = (id: string, name: string, collapsed: boolean, dashboardCollapsed: boolean) =>
  ({ id, name, protected: false, collapsed, dashboardCollapsed, serviceCount: 0, nodeCount: 0, guestCount: 0, position: null }) as Project;

// Folded in the sidebar only, and on the home page only.
const shop = project("p1", "shop", true, false);
const blog = project("p2", "blog", false, true);

const viewer: Answer = [auth.whoami, {}, { viewer: { id: "u1", email: "you@example.com", name: "", role: "owner", avatarUrl: null } }];
const noneHidden: Answer = [auth.preferences, {}, { preferences: {} }];

const realWindow = (globalThis as { window?: unknown }).window;
let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
  };
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

/** Storage that refuses every access, the way a private window with storage off does. */
function blockStorage() {
  (globalThis as { window?: unknown }).window = Object.defineProperty({}, "localStorage", {
    get() {
      throw new Error("SecurityError: The operation is insecure.");
    },
  });
}

const sidebar = (answers: Answer[]) =>
  renderStatic(
    () => (
      <ShellProvider>
        <ProjectsTree />
      </ShellProvider>
    ),
    answers,
  );

const home = (answers: Answer[], data: Partial<ServicesByProject> = {}) => {
  const full: ServicesByProject = { projects: [], services: new Map(), all: [], error: null, pending: false, ...data };
  return renderStatic(
    () => (
      <ShellProvider>
        <ProjectCards data={full} />
      </ShellProvider>
    ),
    answers,
  );
};

/** The placeholder projects drawn, in order: "open" or "collapsed". */
const placeholders = (html: string) => [...html.matchAll(/data-placeholder-project="(open|collapsed)"/g)].map((m) => m[1]);
/** How many service rows the sidebar's placeholders hold. */
const serviceRows = (html: string) => html.match(/pl-\[43px\]/g)?.length ?? 0;
/** How many service cards the home page's Cards placeholders hold (ServiceCardSkeleton). */
const cardPlaceholders = (html: string) =>
  html.match(/class="flex min-w-0 flex-col overflow-hidden rounded-card bg-card shadow-card/g)?.length ?? 0;

test("the sidebar folds by collapsed: shop folded, blog open", async () => {
  const out = await sidebar([viewer, noneHidden, [projects.list, {}, { projects: [shop, blog] }]]);
  expect(out).toContain(`aria-label="${t("sidebar.expand", { name: "shop" })}"`);
  expect(out).toContain(`aria-label="${t("sidebar.collapse", { name: "blog" })}"`);
  expect(out).not.toContain(t("sidebar.collapse", { name: "shop" }));
});

test("the home page folds by dashboardCollapsed, in Cards and List, and Expand all and Collapse all count its own flags", async () => {
  const cards = await home([viewer, noneHidden], { projects: [shop, blog] });
  expect(cards).toContain(`aria-label="${t("sidebar.collapse", { name: "shop" })}"`);
  expect(cards).toContain(`aria-label="${t("sidebar.expand", { name: "blog" })}"`);
  // shop is open here, so its empty grid offers a first service; blog is only its title row.
  expect(cards.match(new RegExp(t("project.addService"), "g"))?.length).toBe(1);
  // One open and one folded: neither Expand all nor Collapse all is the state.
  expect(cards.match(/aria-pressed="true"/g)).toBeNull();

  stored.set(dashboardViewStorage, "list");
  const list = await home([viewer, noneHidden], { projects: [shop, blog] });
  expect(list).toContain(`aria-label="${t("sidebar.collapse", { name: "shop" })}"`);
  expect(list).toContain(`aria-label="${t("sidebar.expand", { name: "blog" })}"`);
  expect(list.match(new RegExp(t("dashboard.noServices"), "g"))?.length).toBe(1);

  // Folded in the sidebar only: everything is open here.
  const allOpen = await home([viewer, noneHidden], { projects: [shop, project("p3", "docs", true, false)] });
  expect(allOpen).toMatch(new RegExp(`aria-pressed="true"[^>]*>(<[^>]+>)*${t("dashboard.expandAll")}`));
});

test("before the projects load, the sidebar's placeholders take the shape it last had", async () => {
  stored.set(
    projectsShapeStorage("sidebar", "u1"),
    JSON.stringify([
      { open: true, services: 2 },
      { open: false, services: 5 },
      { open: false, services: 0 },
      { open: true, services: 1 },
    ]),
  );
  // The home page's shape is its own and does not shape the sidebar.
  stored.set(projectsShapeStorage("dashboard", "u1"), JSON.stringify([{ open: true, services: 9 }]));
  const out = await sidebar([viewer]);
  expect(placeholders(out)).toEqual(["open", "collapsed", "collapsed", "open"]);
  // A placeholder row per service of the open ones only.
  expect(serviceRows(out)).toBe(3);

  // Someone else on this browser gets the usual three folded rows.
  const other = await sidebar([
    [auth.whoami, {}, { viewer: { id: "u2", email: "b@example.com", name: "", role: "member", avatarUrl: null } }],
  ]);
  expect(placeholders(other)).toEqual(["collapsed", "collapsed", "collapsed"]);
  expect(serviceRows(other)).toBe(0);
});

test("before the projects load, the home page's placeholders take its own last shape, in Cards and List", async () => {
  stored.set(
    projectsShapeStorage("dashboard", "u1"),
    JSON.stringify([
      { open: false, services: 4 },
      { open: true, services: 2 },
    ]),
  );
  stored.set(projectsShapeStorage("sidebar", "u1"), JSON.stringify([{ open: true, services: 1 }]));
  const cards = await home([viewer], { pending: true });
  expect(placeholders(cards)).toEqual(["collapsed", "open"]);
  // Cards only under the open one.
  expect(cardPlaceholders(cards)).toBe(2);

  stored.set(dashboardViewStorage, "list");
  const list = await home([viewer], { pending: true });
  // A placeholder card per project; the folded one without service rows.
  expect(list.match(/aria-hidden="true" class="min-w-0 overflow-hidden rounded-card bg-card shadow-card"/g)?.length).toBe(2);
  expect(list.match(/border-t border-divider px-2 py-\[9px\]/g)?.length).toBe(2);
});

test("once the projects load the panel's flags win over the saved shape", async () => {
  // The saved shape says everything is open; the panel says shop is folded in the sidebar.
  stored.set(
    projectsShapeStorage("sidebar", "u1"),
    JSON.stringify([
      { open: true, services: 3 },
      { open: true, services: 3 },
    ]),
  );
  const out = await sidebar([viewer, noneHidden, [projects.list, {}, { projects: [shop, blog] }]]);
  expect(placeholders(out)).toEqual([]);
  expect(out).toContain(`aria-label="${t("sidebar.expand", { name: "shop" })}"`);
});

test("blocked storage draws the usual placeholders in both views", async () => {
  blockStorage();
  const side = await sidebar([viewer]);
  expect(placeholders(side)).toEqual(["collapsed", "collapsed", "collapsed"]);
  const cards = await home([viewer], { pending: true });
  expect(placeholders(cards)).toEqual(["open", "open"]);
  expect(cardPlaceholders(cards)).toBe(6);
  // And the loaded views still fold by their own flags.
  const loaded = await sidebar([viewer, noneHidden, [projects.list, {}, { projects: [shop, blog] }]]);
  expect(loaded).toContain(`aria-label="${t("sidebar.expand", { name: "shop" })}"`);
});
