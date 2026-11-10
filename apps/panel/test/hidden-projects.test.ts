// Hidden projects: auth.preferences.hiddenProjectIds, per person. Only ids
// of projects the person can see are kept; deleted projects and projects
// the person lost access to drop out on read. Hiding changes nothing else:
// projects.list and projects.get still answer for a hidden project.
// auth.preferences.showHiddenInSidebar, also per person, turns the
// sidebar's "Hidden (N)" group off; only false is stored.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { auth, projects as projectOps } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { grants, projects, users } from "../src/db/schema";
import { createUser, grant, type TestPanel, testPanel } from "./helpers";
import { call, noLimits, ok, seedProject } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

const hide = (cookie: string, hiddenProjectIds: string[] | null) =>
  call(panel, auth.updatePreferences, { preferences: { hiddenProjectIds } }, { cookie });
const read = async (cookie: string) => (await ok(panel, auth.preferences, {}, { cookie })).body.preferences as Record<string, unknown>;
const showGroup = (cookie: string, showHiddenInSidebar: boolean | null) =>
  call(panel, auth.updatePreferences, { preferences: { showHiddenInSidebar } }, { cookie });

function seedPanelProject() {
  return panel.deps.db.insert(projects).values({ name: "Panel", nameKey: "panel", protected: true }).returning().get();
}

describe("hidden projects", () => {
  test("nothing is hidden by default; an owner hides the Panel project and unhides it again", async () => {
    const { cookie } = await createUser(panel, "owner");
    const panelProject = seedPanelProject();
    const shop = seedProject(panel, "shop");
    expect(await read(cookie)).toEqual({});

    await ok(panel, auth.updatePreferences, { preferences: { colorMode: "dark" } }, { cookie });
    const hidden = await hide(cookie, [panelProject.id, shop.id]);
    expect(hidden.status).toBe(200);
    expect(hidden.body.preferences).toEqual({ colorMode: "dark", hiddenProjectIds: [panelProject.id, shop.id] });
    expect(await read(cookie)).toEqual({ colorMode: "dark", hiddenProjectIds: [panelProject.id, shop.id] });

    // Hidden only from the sidebar and the home page: the list, the page and the palette still have it.
    const listed = await ok(panel, projectOps.list, {}, { cookie });
    expect(listed.body.projects.map((p: { id: string }) => p.id).sort()).toEqual([panelProject.id, shop.id].sort());
    expect((await ok(panel, projectOps.get, { projectId: panelProject.id }, { cookie })).body.protected).toBe(true);

    expect((await hide(cookie, [shop.id])).body.preferences).toEqual({ colorMode: "dark", hiddenProjectIds: [shop.id] });
    // Unhiding the last one leaves nothing behind, the same as never hiding.
    expect((await hide(cookie, [])).body.preferences).toEqual({ colorMode: "dark" });
    await hide(cookie, [shop.id]);
    expect((await hide(cookie, null)).body.preferences).toEqual({ colorMode: "dark" });
    expect(await read(cookie)).toEqual({ colorMode: "dark" });
  });

  test("the list must be distinct project ids, at most the cap", async () => {
    const { cookie } = await createUser(panel, "owner");
    const shop = seedProject(panel, "shop");

    // Shapes the contract does not allow, sent the way any HTTP client could.
    for (const bad of ["shop", [shop.id, shop.id], ["not-an-id"], [42]] as unknown as string[][]) {
      const answer = await call(panel, auth.updatePreferences, { preferences: { hiddenProjectIds: bad } }, { cookie });
      expect(answer.status).toBe(400);
      expect(answer.body.error.details.field).toStartWith("preferences.hiddenProjectIds");
    }
    const cap = auth.HiddenProjectIds.maxItems as number;
    const tooMany = Array.from({ length: cap + 1 }, (_, i) => i.toString(36).padStart(16, "0"));
    expect((await hide(cookie, tooMany)).status).toBe(400);
    // At the cap is fine; ids that are not projects drop out.
    const atCap = [shop.id, ...tooMany.slice(0, cap - 1)];
    expect((await hide(cookie, atCap)).body.preferences).toEqual({ hiddenProjectIds: [shop.id] });
    expect(await read(cookie)).toEqual({ hiddenProjectIds: [shop.id] });
  });

  test("other people's projects: only projects the person can see are kept, and nobody else's list changes", async () => {
    const owner = await createUser(panel, "owner");
    const member = await createUser(panel, "member");
    const shared = seedProject(panel, "shared");
    const secret = seedProject(panel, "secret");
    grant(panel, member.user.id, "project", shared.id, ["projects.view"]);

    // A project without access answers like an id that does not exist: dropped, no error.
    const answer = await hide(member.cookie, [shared.id, secret.id, "zzzzzzzzzzzzzzzz"]);
    expect(answer.status).toBe(200);
    expect(answer.body.preferences).toEqual({ hiddenProjectIds: [shared.id] });

    expect(await read(owner.cookie)).toEqual({});
    await hide(owner.cookie, [secret.id]);
    expect(await read(member.cookie)).toEqual({ hiddenProjectIds: [shared.id] });
    expect(await read(owner.cookie)).toEqual({ hiddenProjectIds: [secret.id] });
  });

  test("deleted projects and projects the person lost access to drop out on read", async () => {
    const owner = await createUser(panel, "owner");
    const member = await createUser(panel, "member");
    const keep = seedProject(panel, "keep");
    const gone = seedProject(panel, "gone");
    const shared = seedProject(panel, "shared");
    grant(panel, member.user.id, "project", shared.id, ["projects.view"]);

    await hide(owner.cookie, [keep.id, gone.id]);
    await ok(panel, projectOps.remove, { projectId: gone.id, confirmName: "gone" }, { cookie: owner.cookie });
    expect(await read(owner.cookie)).toEqual({ hiddenProjectIds: [keep.id] });
    // Changing another key returns the same cleaned list.
    const other = await ok(panel, auth.updatePreferences, { preferences: { colorMode: "light" } }, { cookie: owner.cookie });
    expect(other.body.preferences).toEqual({ colorMode: "light", hiddenProjectIds: [keep.id] });

    await hide(member.cookie, [shared.id]);
    panel.deps.db
      .delete(grants)
      .where(and(eq(grants.userId, member.user.id), eq(grants.scopeId, shared.id)))
      .run();
    expect(await read(member.cookie)).toEqual({});

    // When every hidden project is gone the key is left out, as if nothing was ever hidden.
    await ok(panel, projectOps.remove, { projectId: keep.id, confirmName: "keep" }, { cookie: owner.cookie });
    expect(await read(owner.cookie)).toEqual({ colorMode: "light" });
  });

  test("a stored value that is not a list of ids is left out on read instead of failing the call", async () => {
    const { user, cookie } = await createUser(panel, "owner");
    const shop = seedProject(panel, "shop");
    // Preferences were free-form before 0.2.1, so anything may be stored under the key.
    for (const stored of ["shop", { a: 1 }, [shop.id, 7, shop.id, "nope"]]) {
      panel.deps.db
        .update(users)
        .set({ preferences: { colorMode: "dark", hiddenProjectIds: stored } })
        .where(eq(users.id, user.id))
        .run();
      const expected = Array.isArray(stored) ? { colorMode: "dark", hiddenProjectIds: [shop.id] } : { colorMode: "dark" };
      expect(await read(cookie)).toEqual(expected);
    }
  });
});

describe("the sidebar's Hidden group", () => {
  test("on by default; off is stored next to the hidden list, and on again leaves nothing behind", async () => {
    const { cookie } = await createUser(panel, "owner");
    const shop = seedProject(panel, "shop");
    await hide(cookie, [shop.id]);
    // Never chosen: the key is missing, which means on.
    expect(await read(cookie)).toEqual({ hiddenProjectIds: [shop.id] });

    const off = await showGroup(cookie, false);
    expect(off.status).toBe(200);
    expect(off.body.preferences).toEqual({ hiddenProjectIds: [shop.id], showHiddenInSidebar: false });
    expect(await read(cookie)).toEqual({ hiddenProjectIds: [shop.id], showHiddenInSidebar: false });

    // Each key changes alone: hiding more keeps the choice, and the choice keeps the list.
    const blog = seedProject(panel, "blog");
    expect((await hide(cookie, [shop.id, blog.id])).body.preferences).toEqual({
      hiddenProjectIds: [shop.id, blog.id],
      showHiddenInSidebar: false,
    });
    expect((await hide(cookie, null)).body.preferences).toEqual({ showHiddenInSidebar: false });
    await hide(cookie, [shop.id]);

    // On is the default, so true and null both leave the key out.
    expect((await showGroup(cookie, true)).body.preferences).toEqual({ hiddenProjectIds: [shop.id] });
    expect(await read(cookie)).toEqual({ hiddenProjectIds: [shop.id] });
    await showGroup(cookie, false);
    expect((await showGroup(cookie, null)).body.preferences).toEqual({ hiddenProjectIds: [shop.id] });
    expect(await read(cookie)).toEqual({ hiddenProjectIds: [shop.id] });
  });

  test("the choice is per person", async () => {
    const owner = await createUser(panel, "owner");
    const member = await createUser(panel, "member");
    await showGroup(member.cookie, false);
    expect(await read(member.cookie)).toEqual({ showHiddenInSidebar: false });
    expect(await read(owner.cookie)).toEqual({});
  });

  test("only true, false or null is taken", async () => {
    const { cookie } = await createUser(panel, "owner");
    // Shapes the contract does not allow, sent the way any HTTP client could.
    for (const bad of ["false", 0, 1, [], {}] as unknown as boolean[]) {
      const answer = await call(panel, auth.updatePreferences, { preferences: { showHiddenInSidebar: bad } }, { cookie });
      expect(answer.status).toBe(400);
      expect(answer.body.error.details.field).toStartWith("preferences.showHiddenInSidebar");
    }
    expect(await read(cookie)).toEqual({});
  });

  test("a stored value other than false is left out on read instead of failing the call", async () => {
    const { user, cookie } = await createUser(panel, "owner");
    // Preferences were free-form before the key had a shape, so anything may be stored under it.
    for (const stored of [true, "false", 0, { a: 1 }, null]) {
      panel.deps.db
        .update(users)
        .set({ preferences: { colorMode: "dark", showHiddenInSidebar: stored } })
        .where(eq(users.id, user.id))
        .run();
      expect(await read(cookie)).toEqual({ colorMode: "dark" });
    }
    // Changing another key stores it cleaned too.
    await ok(panel, auth.updatePreferences, { preferences: { colorMode: "light" } }, { cookie });
    expect(panel.deps.db.select({ preferences: users.preferences }).from(users).where(eq(users.id, user.id)).get()?.preferences).toEqual({
      colorMode: "light",
    });
  });
});
