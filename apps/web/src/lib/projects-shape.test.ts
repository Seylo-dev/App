// The last drawn shape of each view's projects, per person, for the
// placeholders: each view by its own flag, kept apart per view and per
// person, and nothing breaks when storage is blocked or holds junk.

import { expect, test } from "bun:test";
import { slug } from "@seylo/brand";
import { maxShapeRows, maxShapeServices, projectsShapeStorage, readProjectsShape, saveProjectsShape, shapeOf } from "./projects-shape";
import type { Project } from "./types";

const project = (id: string, serviceCount: number, collapsed: boolean, dashboardCollapsed: boolean) =>
  ({ id, name: id, serviceCount, collapsed, dashboardCollapsed }) as unknown as Project;

function memoryStorage() {
  const stored = new Map<string, string>();
  return {
    stored,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
}

const blocked = {
  getItem: () => {
    throw new Error("SecurityError: storage is disabled");
  },
  setItem: () => {
    throw new Error("SecurityError: storage is disabled");
  },
};

test("each view's shape follows its own flag: the sidebar's collapsed, the home page's dashboardCollapsed", () => {
  const list = [project("shop", 3, true, false), project("blog", 1, false, true), project("panel", 2, false, false)];
  expect(shapeOf(list, "sidebar")).toEqual([
    { open: false, services: 3 },
    { open: true, services: 1 },
    { open: true, services: 2 },
  ]);
  expect(shapeOf(list, "dashboard")).toEqual([
    { open: true, services: 3 },
    { open: false, services: 1 },
    { open: true, services: 2 },
  ]);
});

test("a shape is saved per view and per person and read back as it was", () => {
  const storage = memoryStorage();
  saveProjectsShape("sidebar", "u1", [{ open: false, services: 3 }], storage);
  saveProjectsShape("dashboard", "u1", [{ open: true, services: 3 }], storage);
  expect(storage.stored.get(`${slug}.projectsShape.sidebar.u1`)).toBe('[{"open":false,"services":3}]');
  expect(projectsShapeStorage("dashboard", "u1")).toBe(`${slug}.projectsShape.dashboard.u1`);
  expect(readProjectsShape("sidebar", "u1", storage)).toEqual([{ open: false, services: 3 }]);
  expect(readProjectsShape("dashboard", "u1", storage)).toEqual([{ open: true, services: 3 }]);
  // Someone else signing in on this browser starts from the usual placeholders.
  expect(readProjectsShape("sidebar", "u2", storage)).toBeNull();
});

test("nothing saved, junk or blocked storage reads as no shape, and saving into blocked storage does not throw", () => {
  const storage = memoryStorage();
  expect(readProjectsShape("sidebar", "u1", storage)).toBeNull();
  for (const junk of ["not json", "{}", '{"open":true}', '[{"open":"yes","services":1}]', '[{"open":true,"services":-1}]', "[1]"]) {
    storage.stored.set(projectsShapeStorage("sidebar", "u1"), junk);
    expect(readProjectsShape("sidebar", "u1", storage)).toBeNull();
  }
  expect(readProjectsShape("sidebar", "u1", blocked)).toBeNull();
  expect(() => saveProjectsShape("dashboard", "u1", [{ open: true, services: 1 }], blocked)).not.toThrow();
  expect(readProjectsShape("sidebar", "u1", null)).toBeNull();
});

test("a placeholder, not the whole list: at most maxShapeRows projects and maxShapeServices services each", () => {
  const many = Array.from({ length: maxShapeRows + 10 }, (_, i) => project(`p${i}`, 500, false, false));
  const shape = shapeOf(many, "sidebar");
  expect(shape).toHaveLength(maxShapeRows);
  expect(shape[0]).toEqual({ open: true, services: maxShapeServices });
  const storage = memoryStorage();
  storage.stored.set(
    projectsShapeStorage("dashboard", "u1"),
    JSON.stringify(Array.from({ length: 80 }, () => ({ open: true, services: 900 }))),
  );
  const read = readProjectsShape("dashboard", "u1", storage);
  expect(read).toHaveLength(maxShapeRows);
  expect(read?.[0]).toEqual({ open: true, services: maxShapeServices });
});
