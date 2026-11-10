// services.reorder: a person's own order of a project's services, kept on
// the server and used by services.list (the sidebar, the dashboard and the
// project page read it), without changing anyone else's order.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { services as serviceOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { services } from "../src/db/schema";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

const names = async (projectId: string, cookie: string) =>
  ((await callOp(panel, serviceOps.list, { projectId }, { cookie })).body.services as { name: string }[]).map((s) => s.name);

describe("services.reorder", () => {
  test("the order is the person's own, kept on the server, and new services follow by name", async () => {
    const owner = await createUser(panel, "owner");
    const member = await createUser(panel, "member");
    const project = seedProject(panel, "shop");
    const api = seedService(panel, { projectId: project.id, name: "api" });
    const web = seedService(panel, { projectId: project.id, name: "web" });
    const db = seedService(panel, { projectId: project.id, name: "db", kind: "postgres" });
    grant(panel, member.user.id, "project", project.id, ["services.view", "projects.view"]);

    expect(await names(project.id, owner.cookie)).toEqual(["api", "db", "web"]);
    const saved = await callOp(
      panel,
      serviceOps.reorder,
      { projectId: project.id, serviceIds: [web.id, api.id, db.id] },
      { cookie: owner.cookie },
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ projectId: project.id, serviceIds: [web.id, api.id, db.id] });
    expect(await names(project.id, owner.cookie)).toEqual(["web", "api", "db"]);
    // Someone else's order stays theirs.
    expect(await names(project.id, member.cookie)).toEqual(["api", "db", "web"]);

    // A service created later comes after the ordered ones.
    seedService(panel, { projectId: project.id, name: "aaa-worker" });
    expect(await names(project.id, owner.cookie)).toEqual(["web", "api", "db", "aaa-worker"]);
  });

  test("ids of other projects and compose members are left out; members follow their stack", async () => {
    const owner = await createUser(panel, "owner");
    const project = seedProject(panel, "shop");
    const other = seedProject(panel, "blog");
    const stack = seedService(panel, { projectId: project.id, name: "stack", kind: "compose" });
    const member = seedService(panel, { projectId: project.id, name: "cache" });
    panel.deps.db.update(services).set({ parentId: stack.id }).where(eq(services.id, member.id)).run();
    const web = seedService(panel, { projectId: project.id, name: "web" });
    const foreign = seedService(panel, { projectId: other.id, name: "posts" });

    const saved = await callOp(
      panel,
      serviceOps.reorder,
      { projectId: project.id, serviceIds: [foreign.id, member.id, web.id, stack.id] },
      { cookie: owner.cookie },
    );
    expect(saved.body.serviceIds).toEqual([web.id, stack.id]);
    expect(await names(project.id, owner.cookie)).toEqual(["web", "stack", "cache"]);
  });

  test("needs to see the project", async () => {
    await createUser(panel, "owner");
    const stranger = await createUser(panel, "member");
    const project = seedProject(panel, "shop");
    const res = await callOp(panel, serviceOps.reorder, { projectId: project.id, serviceIds: [] }, { cookie: stranger.cookie });
    expect(res.status).toBe(403);
  });
});
