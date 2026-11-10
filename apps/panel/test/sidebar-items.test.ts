// Sidebar items: auth.preferences.hiddenSidebarItems, per person, the main
// navigation items someone took out of their sidebar under Settings >
// Preferences. Missing means none. Only names in auth.sidebarItems are kept:
// unknown names and "settings" (which never hides) drop out without an
// error, and an empty list leaves the key out.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { auth } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { users } from "../src/db/schema";
import { createUser, type TestPanel, testPanel } from "./helpers";
import { call, noLimits, ok, seedProject } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

const hideItems = (cookie: string, hiddenSidebarItems: string[] | null) =>
  call(panel, auth.updatePreferences, { preferences: { hiddenSidebarItems } }, { cookie });
const read = async (cookie: string) => (await ok(panel, auth.preferences, {}, { cookie })).body.preferences as Record<string, unknown>;

describe("hidden sidebar items", () => {
  test("none by default; a list is stored next to the other keys, and an empty list or null leaves nothing behind", async () => {
    const { cookie } = await createUser(panel, "owner");
    expect(await read(cookie)).toEqual({});
    const shop = seedProject(panel, "shop");
    await call(panel, auth.updatePreferences, { preferences: { hiddenProjectIds: [shop.id], showHiddenInSidebar: false } }, { cookie });

    const hidden = await hideItems(cookie, ["templates", "activity"]);
    expect(hidden.status).toBe(200);
    expect(hidden.body.preferences).toEqual({
      hiddenProjectIds: [shop.id],
      showHiddenInSidebar: false,
      hiddenSidebarItems: ["templates", "activity"],
    });
    expect(await read(cookie)).toEqual({
      hiddenProjectIds: [shop.id],
      showHiddenInSidebar: false,
      hiddenSidebarItems: ["templates", "activity"],
    });

    // Each key changes alone: the other keys keep the list, and the list keeps them.
    await call(panel, auth.updatePreferences, { preferences: { hiddenProjectIds: null } }, { cookie });
    expect(await read(cookie)).toEqual({ showHiddenInSidebar: false, hiddenSidebarItems: ["templates", "activity"] });
    expect((await hideItems(cookie, ["approvals"])).body.preferences).toEqual({
      showHiddenInSidebar: false,
      hiddenSidebarItems: ["approvals"],
    });

    // Every item back on is the same as never choosing.
    expect((await hideItems(cookie, [])).body.preferences).toEqual({ showHiddenInSidebar: false });
    await hideItems(cookie, ["dashboard"]);
    expect((await hideItems(cookie, null)).body.preferences).toEqual({ showHiddenInSidebar: false });
    expect(await read(cookie)).toEqual({ showHiddenInSidebar: false });
  });

  test("every item but Settings can be hidden; unknown names and settings drop out without an error", async () => {
    const { cookie } = await createUser(panel, "owner");
    const all = await hideItems(cookie, [...auth.sidebarItems]);
    expect(all.body.preferences).toEqual({ hiddenSidebarItems: ["dashboard", "nodes", "templates", "activity", "approvals"] });

    // An item another web app knows, and Settings, which must stay to bring the others back.
    const mixed = await hideItems(cookie, ["assistant", "templates", "settings", "Templates", "nodes"]);
    expect(mixed.status).toBe(200);
    expect(mixed.body.preferences).toEqual({ hiddenSidebarItems: ["templates", "nodes"] });
    expect(await read(cookie)).toEqual({ hiddenSidebarItems: ["templates", "nodes"] });

    // Nothing known left: the key goes, the same as hiding nothing.
    expect((await hideItems(cookie, ["settings", "assistant"])).body.preferences).toEqual({});
    expect(await read(cookie)).toEqual({});
  });

  test("the list must be distinct short names, at most the cap", async () => {
    const { cookie } = await createUser(panel, "owner");
    // Shapes the contract does not allow, sent the way any HTTP client could.
    for (const bad of ["templates", ["nodes", "nodes"], [""], [7], ["x".repeat(41)], Array.from({ length: 33 }, (_, i) => `item-${i}`)]) {
      const answer = await hideItems(cookie, bad as unknown as string[]);
      expect(answer.status).toBe(400);
      expect(answer.body.error.details.field).toStartWith("preferences.hiddenSidebarItems");
    }
    expect(await read(cookie)).toEqual({});
  });

  test("the list is per person", async () => {
    const owner = await createUser(panel, "owner");
    const member = await createUser(panel, "member");
    await hideItems(member.cookie, ["templates"]);
    expect(await read(member.cookie)).toEqual({ hiddenSidebarItems: ["templates"] });
    expect(await read(owner.cookie)).toEqual({});
    await hideItems(owner.cookie, ["activity"]);
    expect(await read(member.cookie)).toEqual({ hiddenSidebarItems: ["templates"] });
  });

  test("a stored value that is not a list of known names is cleaned on read instead of failing the call", async () => {
    const { user, cookie } = await createUser(panel, "owner");
    // Preferences were free-form before the key had a shape, so anything may be stored under it.
    const cases: [unknown, Record<string, unknown>][] = [
      ["templates", { colorMode: "dark" }],
      [{ a: 1 }, { colorMode: "dark" }],
      [null, { colorMode: "dark" }],
      [["templates", 7, "templates", "settings", "nope", "activity"], { colorMode: "dark", hiddenSidebarItems: ["templates", "activity"] }],
    ];
    for (const [stored, expected] of cases) {
      panel.deps.db
        .update(users)
        .set({ preferences: { colorMode: "dark", hiddenSidebarItems: stored } })
        .where(eq(users.id, user.id))
        .run();
      expect(await read(cookie)).toEqual(expected);
    }
    // Changing another key stores it cleaned too.
    await ok(panel, auth.updatePreferences, { preferences: { colorMode: "light" } }, { cookie });
    expect(panel.deps.db.select({ preferences: users.preferences }).from(users).where(eq(users.id, user.id)).get()?.preferences).toEqual({
      colorMode: "light",
      hiddenSidebarItems: ["templates", "activity"],
    });
  });
});
