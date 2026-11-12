// Collapsing the References panel's groups: the service itself and short
// groups start expanded, a long one collapsed; a click flips one group,
// Expand all and Collapse all set them all, and the choices are remembered
// per project in this browser, with blocked storage never in the way.

import { expect, test } from "bun:test";
import {
  collapseAbove,
  collapsedByDefault,
  collapseStorageKey,
  groupKey,
  isCollapsed,
  readCollapseChoices,
  saveCollapseChoices,
  selfGroupKey,
  setAllCollapsed,
  toggleCollapsed,
} from "./references-collapse";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

const project = "prj0000000000001";
const api = { key: "service:svc0000000000api", chips: 34 };
const db = { key: "service:svc00000000000db", chips: 9 };
const shared = { key: "shared", chips: 3 };

test("the service itself and short groups start expanded, a long group collapsed", () => {
  // A database's whole set (9) stays expanded; an app with its own 30 variables does not.
  expect(collapseAbove).toBeGreaterThanOrEqual(9);
  expect(collapsedByDefault(db)).toBe(false);
  expect(collapsedByDefault(shared)).toBe(false);
  expect(collapsedByDefault({ key: "service:x", chips: collapseAbove })).toBe(false);
  expect(collapsedByDefault({ key: "service:x", chips: collapseAbove + 1 })).toBe(true);
  expect(collapsedByDefault(api)).toBe(true);
  // The service being edited is never collapsed until someone collapses it.
  expect(collapsedByDefault({ key: selfGroupKey, chips: 40 })).toBe(false);
  expect(isCollapsed({}, api)).toBe(true);
  expect(isCollapsed({}, db)).toBe(false);
});

test("a click flips one group and leaves the others as they were", () => {
  const opened = toggleCollapsed({}, api);
  expect(opened).toEqual({ [api.key]: false });
  expect(isCollapsed(opened, api)).toBe(false);
  expect(isCollapsed(opened, db)).toBe(false);
  const closed = toggleCollapsed(opened, db);
  expect(isCollapsed(closed, db)).toBe(true);
  expect(isCollapsed(closed, api)).toBe(false);
  // Again: back to expanded, kept as a choice (not the default any more).
  expect(isCollapsed(toggleCollapsed(closed, db), db)).toBe(false);
  // The input is not changed.
  expect(opened).toEqual({ [api.key]: false });
});

test("Expand all and Collapse all set every group shown", () => {
  const groups = [{ key: selfGroupKey, chips: 3 }, db, api, shared];
  const expanded = setAllCollapsed({}, groups, false);
  for (const group of groups) expect(isCollapsed(expanded, group)).toBe(false);
  const collapsed = setAllCollapsed(expanded, groups, true);
  for (const group of groups) expect(isCollapsed(collapsed, group)).toBe(true);
  // A group not on screen keeps its choice.
  expect(setAllCollapsed({ "service:gone": false }, groups, true)["service:gone"]).toBe(false);
});

test("groups are keyed by service id, the shared variables by kind", () => {
  expect(groupKey({ kind: "service", name: "api", serviceId: "svc0000000000api" })).toBe("service:svc0000000000api");
  // A rename keeps the choice.
  expect(groupKey({ kind: "service", name: "api-v2", serviceId: "svc0000000000api" })).toBe("service:svc0000000000api");
  expect(groupKey({ kind: "shared", name: "project", serviceId: null })).toBe("shared");
});

test("the choices are remembered in this browser, per project", () => {
  const storage = memoryStorage();
  expect(readCollapseChoices(project, storage)).toEqual({});
  const choices = toggleCollapsed(toggleCollapsed({}, api), db);
  saveCollapseChoices(project, choices, storage);
  expect(storage.items.get(collapseStorageKey(project))).toBe(JSON.stringify({ [api.key]: false, [db.key]: true }));
  // A reload reads them back.
  const read = readCollapseChoices(project, storage);
  expect(isCollapsed(read, api)).toBe(false);
  expect(isCollapsed(read, db)).toBe(true);
  // Another project starts from the defaults.
  expect(readCollapseChoices("prj0000000000002", storage)).toEqual({});
  expect(collapseStorageKey(project)).not.toBe(collapseStorageKey("prj0000000000002"));
});

test("something unreadable saved (a hand edit, another build) reads as no choices", () => {
  const storage = memoryStorage();
  for (const value of ["not json", "[true]", "null", "7", '"x"']) {
    storage.items.set(collapseStorageKey(project), value);
    expect(readCollapseChoices(project, storage)).toEqual({});
  }
  // Only true or false count.
  storage.items.set(collapseStorageKey(project), JSON.stringify({ [api.key]: false, [db.key]: "yes", shared: 1 }));
  expect(readCollapseChoices(project, storage)).toEqual({ [api.key]: false });
});

test("blocked storage never throws: the defaults, and a choice holds until the page is left", () => {
  const blocked = {
    getItem: (): string | null => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  expect(readCollapseChoices(project, blocked)).toEqual({});
  expect(() => saveCollapseChoices(project, { [api.key]: false }, blocked)).not.toThrow();
  expect(readCollapseChoices(project, null)).toEqual({});
  expect(() => saveCollapseChoices(project, { [api.key]: false }, null)).not.toThrow();
  // No window at all (the static render of the tests).
  expect(readCollapseChoices(project)).toEqual({});
  expect(() => saveCollapseChoices(project, {})).not.toThrow();
});
