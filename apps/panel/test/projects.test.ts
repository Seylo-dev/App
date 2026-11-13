import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deployments, projects, services } from "@seylo/ops";
import { desc } from "drizzle-orm";
import { auditLog } from "../src/db/schema";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

describe("projects", () => {
  test("an owner creates, lists, reads and deletes a project", async () => {
    const { cookie } = await createUser(panel, "owner");

    const created = await callOp(panel, projects.create, { name: "acme-shop", description: "Shop" }, { cookie });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: "acme-shop", description: "Shop", protected: false, serviceCount: 0 });
    const id = created.body.id as string;

    const listed = await callOp(panel, projects.list, {}, { cookie });
    expect(listed.body.projects.map((p: { id: string }) => p.id)).toEqual([id]);

    const got = await callOp(panel, projects.get, { projectId: id }, { cookie });
    expect(got.body.id).toBe(id);

    const wrongName = await callOp(panel, projects.remove, { projectId: id, confirmName: "nope" }, { cookie });
    expect(wrongName.body.error.code).toBe("BAD_REQUEST");

    const deleted = await callOp(panel, projects.remove, { projectId: id, confirmName: "acme-shop" }, { cookie });
    expect(deleted.status).toBe(200);
    expect((await callOp(panel, projects.get, { projectId: id }, { cookie })).body.error.code).toBe("NOT_FOUND");
  });

  test("names are unique regardless of case", async () => {
    const { cookie } = await createUser(panel, "owner");
    await callOp(panel, projects.create, { name: "Shop" }, { cookie });
    const again = await callOp(panel, projects.create, { name: "shop" }, { cookie });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: "CONFLICT", details: { field: "name" } });
  });

  test("members only see projects they hold a grant on and cannot create", async () => {
    const { cookie: ownerCookie } = await createUser(panel, "owner");
    const a = (await callOp(panel, projects.create, { name: "a" }, { cookie: ownerCookie })).body.id as string;
    await callOp(panel, projects.create, { name: "b" }, { cookie: ownerCookie });

    const { user, cookie } = await createUser(panel, "member");
    grant(panel, user.id, "project", a, ["projects.view"]);

    const listed = await callOp(panel, projects.list, {}, { cookie });
    expect(listed.body.projects.map((p: { name: string }) => p.name)).toEqual(["a"]);

    const create = await callOp(panel, projects.create, { name: "c" }, { cookie });
    expect(create.body.error).toMatchObject({ code: "FORBIDDEN", details: { action: "projects.create" } });

    const del = await callOp(panel, projects.remove, { projectId: a, confirmName: "a" }, { cookie });
    expect(del.body.error.code).toBe("FORBIDDEN");
  });

  test("mutations are audited with the actor and target", async () => {
    const { user, cookie } = await createUser(panel, "owner");
    const id = (await callOp(panel, projects.create, { name: "audited" }, { cookie })).body.id as string;
    await callOp(panel, projects.remove, { projectId: id, confirmName: "audited" }, { cookie });

    const rows = panel.deps.db.select().from(auditLog).orderBy(desc(auditLog.id)).all();
    expect(rows.map((r) => r.opId)).toEqual(["projects.delete", "projects.create"]);
    expect(rows[0]).toMatchObject({ actorType: "user", actorId: user.id, targetType: "project", targetId: id, outcome: "ok" });
  });

  test("creating a project tells live subscribers to refetch the list", async () => {
    const { cookie } = await createUser(panel, "owner");
    const received: unknown[] = [];
    panel.deps.live.subscribe({ id: "tab", send: (m) => received.push(m) }, "panel");
    await callOp(panel, projects.create, { name: "live" }, { cookie });
    expect(received).toEqual([{ type: "event", topic: "panel", event: { type: "invalidate", ops: ["projects.list"] } }]);
  });

  test("projects carry node and guest counts and the network name", async () => {
    const { cookie } = await createUser(panel, "owner");
    const id = (await callOp(panel, projects.create, { name: "counts" }, { cookie })).body.id as string;
    const { user: guest } = await createUser(panel, "member");
    grant(panel, guest.id, "project", id, ["projects.view"]);

    const got = await callOp(panel, projects.get, { projectId: id }, { cookie });
    expect(got.body).toMatchObject({
      serviceCount: 0,
      nodeCount: 0,
      guestCount: 1,
      networkName: `seylo-p-${id}`,
      collapsed: false,
      dashboardCollapsed: false,
      position: null,
    });
  });

  test("update renames and describes, and refuses a taken name", async () => {
    const { cookie } = await createUser(panel, "owner");
    const id = (await callOp(panel, projects.create, { name: "old" }, { cookie })).body.id as string;
    await callOp(panel, projects.create, { name: "Taken" }, { cookie });

    const renamed = await callOp(panel, projects.update, { projectId: id, name: "new", description: "Hello" }, { cookie });
    expect(renamed.body).toMatchObject({ id, name: "new", description: "Hello" });

    const clash = await callOp(panel, projects.update, { projectId: id, name: "taken" }, { cookie });
    expect(clash.body.error).toMatchObject({ code: "CONFLICT", details: { field: "name" } });

    const sameName = await callOp(panel, projects.update, { projectId: id, name: "NEW" }, { cookie });
    expect(sameName.body.name).toBe("NEW");
  });

  test("collapsed state and order are per person", async () => {
    const { cookie: ownerCookie } = await createUser(panel, "owner");
    const a = (await callOp(panel, projects.create, { name: "a" }, { cookie: ownerCookie })).body.id as string;
    const b = (await callOp(panel, projects.create, { name: "b" }, { cookie: ownerCookie })).body.id as string;
    const c = (await callOp(panel, projects.create, { name: "c" }, { cookie: ownerCookie })).body.id as string;
    const { cookie: adminCookie } = await createUser(panel, "admin");

    const collapsed = await callOp(panel, projects.setCollapsed, { projectId: b, collapsed: true }, { cookie: ownerCookie });
    expect(collapsed.body).toEqual({ projectId: b, collapsed: true, where: "sidebar" });
    const reordered = await callOp(panel, projects.reorder, { projectIds: [c, a] }, { cookie: ownerCookie });
    expect(reordered.body.projectIds).toEqual([c, a]);

    const mine = (await callOp(panel, projects.list, {}, { cookie: ownerCookie })).body.projects;
    expect(mine.map((p: { name: string }) => p.name)).toEqual(["c", "a", "b"]);
    expect(mine.find((p: { id: string }) => p.id === b).collapsed).toBe(true);

    const theirs = (await callOp(panel, projects.list, {}, { cookie: adminCookie })).body.projects;
    expect(theirs.map((p: { name: string }) => p.name)).toEqual(["a", "b", "c"]);
    expect(theirs.every((p: { collapsed: boolean }) => !p.collapsed)).toBe(true);

    // Leaving a project out of a new order drops its position.
    await callOp(panel, projects.reorder, { projectIds: [b] }, { cookie: ownerCookie });
    const again = (await callOp(panel, projects.list, {}, { cookie: ownerCookie })).body.projects;
    expect(again.map((p: { name: string }) => p.name)).toEqual(["b", "a", "c"]);
  });

  test("the sidebar and the home page collapse on their own; left out, where is the sidebar", async () => {
    const { cookie } = await createUser(panel, "owner");
    const a = (await callOp(panel, projects.create, { name: "a" }, { cookie })).body.id as string;
    const b = (await callOp(panel, projects.create, { name: "b" }, { cookie })).body.id as string;
    const { cookie: otherCookie } = await createUser(panel, "admin");
    const flags = async (who = cookie) =>
      Object.fromEntries(
        (await callOp(panel, projects.list, {}, { cookie: who })).body.projects.map(
          (p: { name: string; collapsed: boolean; dashboardCollapsed: boolean }) => [p.name, [p.collapsed, p.dashboardCollapsed]],
        ),
      );

    // The home page folds a; the sidebar keeps it open.
    const home = await callOp(panel, projects.setCollapsed, { projectId: a, collapsed: true, where: "dashboard" }, { cookie });
    expect(home.body).toEqual({ projectId: a, collapsed: true, where: "dashboard" });
    expect(await flags()).toEqual({ a: [false, true], b: [false, false] });

    // The sidebar folds b (where left out, as callers before 0.2.16 send it); the home page keeps it open.
    const side = await callOp(panel, projects.setCollapsed, { projectId: b, collapsed: true }, { cookie });
    expect(side.body).toEqual({ projectId: b, collapsed: true, where: "sidebar" });
    expect(await flags()).toEqual({ a: [false, true], b: [true, false] });

    // Each flag changes only itself on a row that has both.
    await callOp(panel, projects.setCollapsed, { projectId: a, collapsed: true, where: "sidebar" }, { cookie });
    await callOp(panel, projects.setCollapsed, { projectId: a, collapsed: false, where: "dashboard" }, { cookie });
    expect(await flags()).toEqual({ a: [true, false], b: [true, false] });
    await callOp(panel, projects.setCollapsed, { projectId: b, collapsed: true, where: "dashboard" }, { cookie });
    await callOp(panel, projects.setCollapsed, { projectId: b, collapsed: false, where: "sidebar" }, { cookie });
    expect(await flags()).toEqual({ a: [true, false], b: [false, true] });
    expect((await callOp(panel, projects.get, { projectId: b }, { cookie })).body).toMatchObject({
      collapsed: false,
      dashboardCollapsed: true,
    });

    // Per person: the other person's views did not change.
    expect(await flags(otherCookie)).toEqual({ a: [false, false], b: [false, false] });

    // Only the two views exist.
    const wrong = await callOp(panel, projects.setCollapsed, { projectId: a, collapsed: true, where: "page" as never }, { cookie });
    expect(wrong.body.error.code).toBe("BAD_REQUEST");
    expect(await flags()).toEqual({ a: [true, false], b: [false, true] });
  });

  test("collapsing needs projects.view on the project, in either view", async () => {
    const { cookie: ownerCookie } = await createUser(panel, "owner");
    const seen = (await callOp(panel, projects.create, { name: "seen" }, { cookie: ownerCookie })).body.id as string;
    const unseen = (await callOp(panel, projects.create, { name: "unseen" }, { cookie: ownerCookie })).body.id as string;
    const { user, cookie } = await createUser(panel, "member");
    grant(panel, user.id, "project", seen, ["projects.view"]);

    for (const where of ["sidebar", "dashboard"] as const) {
      const refused = await callOp(panel, projects.setCollapsed, { projectId: unseen, collapsed: true, where }, { cookie });
      expect(refused.body.error).toMatchObject({ code: "FORBIDDEN", details: { action: "projects.view" } });
      const allowed = await callOp(panel, projects.setCollapsed, { projectId: seen, collapsed: true, where }, { cookie });
      expect(allowed.body).toEqual({ projectId: seen, collapsed: true, where });
    }
    const mine = (await callOp(panel, projects.list, {}, { cookie })).body.projects;
    expect(mine).toMatchObject([{ id: seen, collapsed: true, dashboardCollapsed: true }]);
    // The owner's own flags stayed open.
    const owners = (await callOp(panel, projects.list, {}, { cookie: ownerCookie })).body.projects;
    expect(owners.map((p: { collapsed: boolean; dashboardCollapsed: boolean }) => [p.collapsed, p.dashboardCollapsed])).toEqual([
      [false, false],
      [false, false],
    ]);
    // An unknown project is not found for someone who could see any project.
    const missing = await callOp(
      panel,
      projects.setCollapsed,
      { projectId: "0123456789abcdef", collapsed: true, where: "dashboard" },
      { cookie: ownerCookie },
    );
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  test("reorder skips projects the caller cannot see", async () => {
    const { cookie: ownerCookie } = await createUser(panel, "owner");
    const a = (await callOp(panel, projects.create, { name: "a" }, { cookie: ownerCookie })).body.id as string;
    const hidden = (await callOp(panel, projects.create, { name: "hidden" }, { cookie: ownerCookie })).body.id as string;
    const { user, cookie } = await createUser(panel, "member");
    grant(panel, user.id, "project", a, ["projects.view"]);

    const reordered = await callOp(panel, projects.reorder, { projectIds: [hidden, a] }, { cookie });
    expect(reordered.body.projectIds).toEqual([a]);
  });

  test("a new project lists no services; unknown services are not found", async () => {
    const { cookie } = await createUser(panel, "owner");
    const id = (await callOp(panel, projects.create, { name: "seam" }, { cookie })).body.id as string;
    const listed = await callOp(panel, services.list, { projectId: id }, { cookie });
    expect(listed.body).toEqual({ services: [] });
    const deployed = await callOp(panel, deployments.deploy, { serviceId: "0123456789abcdef" }, { cookie });
    expect(deployed.body.error.code).toBe("NOT_FOUND");
  });
});
