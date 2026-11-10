import { expect, test } from "bun:test";
import { dashboardViewStorage, defaultDashboardView, isDashboardView, readDashboardView, saveDashboardView } from "./dashboard-view";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

test("a viewer who never picked a view gets cards", () => {
  expect(defaultDashboardView).toBe("cards");
  expect(readDashboardView(memoryStorage())).toBe("cards");
});

test("the picked view is remembered in this browser's storage", () => {
  const storage = memoryStorage();
  saveDashboardView("table", storage);
  expect(storage.items.get(dashboardViewStorage)).toBe("table");
  expect(readDashboardView(storage)).toBe("table");
  saveDashboardView("list", storage);
  expect(readDashboardView(storage)).toBe("list");
});

test("a value the app does not know (an older or newer build, a hand edit) reads as cards", () => {
  const storage = memoryStorage();
  for (const value of ["grid", "", "TABLE", "null"]) {
    storage.items.set(dashboardViewStorage, value);
    expect(readDashboardView(storage)).toBe("cards");
  }
  expect(isDashboardView("list")).toBe(true);
  expect(isDashboardView(undefined)).toBe(false);
});

test("blocked storage never throws: the page shows cards, and a choice lasts until the page is left", () => {
  const blocked = {
    getItem: (): string | null => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  expect(readDashboardView(blocked)).toBe("cards");
  expect(() => saveDashboardView("table", blocked)).not.toThrow();
  expect(readDashboardView(null)).toBe("cards");
  expect(() => saveDashboardView("table", null)).not.toThrow();
  // No window at all (the static render of the tests).
  expect(readDashboardView()).toBe("cards");
});
