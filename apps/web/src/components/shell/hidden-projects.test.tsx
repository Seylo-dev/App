import { expect, test } from "bun:test";
import { auth, projects } from "@seylo/ops";
import { t } from "../../i18n/t";
import type { Project } from "../../lib/types";
import type { ServicesByProject } from "../../lib/use-all-services";
import { hiddenChange, maxHiddenProjects, splitHidden, withHidden } from "../../lib/use-hidden-projects";
import { type Answer, renderStatic } from "../../test/render";
import { ProjectCards } from "../dashboard/project-cards";
import { ProjectsTree } from "./projects-tree";
import { ShellProvider } from "./shell-context";

const project = (id: string, name: string, extra: Partial<Project> = {}) =>
  ({ id, name, protected: false, collapsed: true, serviceCount: 0, nodeCount: 0, guestCount: 0, position: null, ...extra }) as Project;
const panel = project("p1", "Panel", { protected: true });
const shop = project("p2", "shop");
const blog = project("p3", "blog");
const list = [panel, shop, blog];
const prefs = (hiddenProjectIds?: string[]): Answer => [
  auth.preferences,
  {},
  { preferences: hiddenProjectIds ? { hiddenProjectIds } : {} },
];

const sidebar = (answers: Answer[]) =>
  renderStatic(
    () => (
      <ShellProvider>
        <ProjectsTree />
      </ShellProvider>
    ),
    [[projects.list, {}, { projects: list }], ...answers],
  );

const grid = (answers: Answer[], projectsShown = list) => {
  const data: ServicesByProject = { projects: projectsShown, services: new Map(), all: [], error: null, pending: false };
  return renderStatic(
    () => (
      <ShellProvider>
        <ProjectCards data={data} />
      </ShellProvider>
    ),
    answers,
  );
};

const hiddenRow = (count: number) => `>${t("sidebar.hidden", { count })}</button>`;

test("splitHidden keeps list order on both sides; withHidden adds at the end and never twice", () => {
  expect(splitHidden(list, new Set(["p1", "p3"]))).toEqual({ shown: [shop], hidden: [panel, blog] });
  expect(splitHidden(list, new Set())).toEqual({ shown: list, hidden: [] });
  expect(withHidden(["p1"], "p2", true)).toEqual(["p1", "p2"]);
  expect(withHidden(["p2", "p1"], "p2", true)).toEqual(["p1", "p2"]);
  expect(withHidden(["p1", "p2"], "p1", false)).toEqual(["p2"]);
  expect(withHidden([], "p1", false)).toEqual([]);
});

test("hiddenChange saves the new list, refuses past the cap, and saves nothing when the list never loaded", () => {
  expect(hiddenChange({ preferences: { hiddenProjectIds: ["p1"] } }, "p2", true)).toEqual(["p1", "p2"]);
  expect(hiddenChange({ preferences: {} }, "p1", true)).toEqual(["p1"]);
  expect(hiddenChange({ preferences: { hiddenProjectIds: ["p1", "p2"] } }, "p1", false)).toEqual(["p2"]);
  const full = Array.from({ length: maxHiddenProjects }, (_, i) => `id${i}`);
  expect(hiddenChange({ preferences: { hiddenProjectIds: full } }, "p1", true)).toBe("limit");
  expect(hiddenChange({ preferences: { hiddenProjectIds: full } }, "id0", false)).toHaveLength(maxHiddenProjects - 1);
  // A failed read leaves no list: saving [p1] would unhide every other hidden project.
  expect(hiddenChange(undefined, "p1", true)).toBe("unread");
  expect(hiddenChange(undefined, "p1", false)).toBe("unread");
});

test("the sidebar leaves hidden projects out and folds them under Hidden (N) at the end", async () => {
  const out = await sidebar([prefs(["p1"])]);
  expect(out).toContain(">shop<");
  expect(out).toContain(">blog<");
  expect(out).not.toContain(">Panel<");
  expect(out).toContain(hiddenRow(1));
  expect(out).toContain('aria-expanded="false"');
  // The row comes after every shown project.
  expect(out.indexOf(hiddenRow(1))).toBeGreaterThan(out.indexOf(">blog<"));
  // Every row has its "..." menu.
  expect(out).toContain(`aria-label="${t("sidebar.projectMenu", { name: "shop" })}"`);
});

test("with nothing hidden the sidebar has no Hidden row and every project shows", async () => {
  for (const answer of [prefs(), prefs([])]) {
    const out = await sidebar([answer]);
    for (const name of ["Panel", "shop", "blog"]) expect(out).toContain(`>${name}<`);
    for (const count of [0, 1, 2, 3]) expect(out).not.toContain(hiddenRow(count));
  }
});

test("the sidebar waits for the preferences instead of showing a hidden project for a moment", async () => {
  const out = await sidebar([]);
  expect(out).not.toContain(">Panel<");
  expect(out).not.toContain(">shop<");
  expect(out).toContain('data-slot="skeleton"');
});

test("ids of projects not in the list (deleted since) do not count in Hidden (N)", async () => {
  const out = await sidebar([prefs(["p2", "gone000000000001"])]);
  expect(out).toContain(hiddenRow(1));
  expect(out).not.toContain(">shop<");
});

test("the home grid leaves hidden projects out and offers Show hidden (N)", async () => {
  const out = await grid([prefs(["p1", "p3"])]);
  expect(out).toContain(">shop<");
  expect(out).not.toContain(">Panel<");
  expect(out).not.toContain(">blog<");
  expect(out).toContain(t("dashboard.showHidden", { count: 2 }));
  expect(out).toContain(`aria-label="${t("sidebar.projectMenu", { name: "shop" })}"`);
});

test("with nothing hidden the home grid has no Show hidden toggle", async () => {
  const out = await grid([prefs()]);
  for (const name of ["Panel", "shop", "blog"]) expect(out).toContain(`>${name}<`);
  for (const count of [0, 1, 2, 3]) expect(out).not.toContain(t("dashboard.showHidden", { count }));
  expect(out).not.toContain(t("dashboard.allHidden"));
});

test("the home grid says so when every project is hidden, and waits for the preferences", async () => {
  const all = await grid([prefs(["p1", "p2", "p3"])]);
  expect(all).toContain(t("dashboard.allHidden"));
  expect(all).toContain(t("dashboard.showHidden", { count: 3 }));
  expect(all).not.toContain(t("dashboard.noProjects"));

  const waiting = await grid([]);
  expect(waiting).not.toContain(">shop<");
  expect(waiting).toContain('data-slot="skeleton"');
});
