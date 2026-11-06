// Sharing projects and services: who can grant what, inheritance in the
// lists, and area wildcards.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { grants as grantOps } from "@seylo/ops";
import { createAccess } from "../src/auth/access";
import { createUser, grant, type TestPanel, testPanel } from "./helpers";
import { call, noLimits, ok, seedProject, seedService } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

test("set, list with inheritance, and remove", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const project = seedProject(panel);
  const api = seedService(panel, project.id, "api");

  const onProject = await ok(
    panel,
    grantOps.setOnProject,
    { projectId: project.id, userId: member.user.id, actions: ["services.view"] },
    { cookie: owner.cookie },
  );
  expect(onProject.body).toMatchObject({
    scopeType: "project",
    scopeName: project.name,
    actions: ["services.view"],
    createdBy: owner.user.id,
  });
  await ok(
    panel,
    grantOps.setOnService,
    { serviceId: api.id, userId: member.user.id, actions: ["services.deploy", "logs.view"] },
    { cookie: owner.cookie },
  );

  const byProject = await ok(panel, grantOps.listByProject, { projectId: project.id }, { cookie: owner.cookie });
  expect(byProject.body.grants).toHaveLength(2);
  expect(byProject.body.grants[0].user.email).toBe(member.user.email);
  const byService = await ok(panel, grantOps.listByService, { serviceId: api.id }, { cookie: owner.cookie });
  expect(byService.body.grants.map((g: { inherited: boolean }) => g.inherited).sort()).toEqual([false, true]);
  const mine = await ok(panel, grantOps.mine, {}, { cookie: member.cookie });
  expect(mine.body.grants).toHaveLength(2);
  expect((await ok(panel, grantOps.mine, {}, { cookie: owner.cookie })).body.grants).toEqual([]);

  // Replacing keeps one row.
  await ok(
    panel,
    grantOps.setOnProject,
    { projectId: project.id, userId: member.user.id, actions: ["projects.view"] },
    { cookie: owner.cookie },
  );
  expect((await ok(panel, grantOps.listByUser, { userId: member.user.id }, { cookie: owner.cookie })).body.grants).toHaveLength(2);

  await ok(panel, grantOps.removeFromService, { serviceId: api.id, userId: member.user.id }, { cookie: owner.cookie });
  expect(
    (await call(panel, grantOps.removeFromService, { serviceId: api.id, userId: member.user.id }, { cookie: owner.cookie })).status,
  ).toBe(404);
  expect((await ok(panel, grantOps.mine, {}, { cookie: member.cookie })).body.grants).toHaveLength(1);
});

test("members with grants.manage share only what they hold, never with themselves", async () => {
  const sharer = await createUser(panel, "member");
  const friend = await createUser(panel, "member");
  const project = seedProject(panel);
  const api = seedService(panel, project.id);
  grant(panel, sharer.user.id, "project", project.id, ["grants.manage", "grants.view", "services.view", "logs.view"]);

  const fine = await call(
    panel,
    grantOps.setOnService,
    { serviceId: api.id, userId: friend.user.id, actions: ["logs.view"] },
    { cookie: sharer.cookie },
  );
  expect(fine.status).toBe(200);
  const more = await call(
    panel,
    grantOps.setOnService,
    { serviceId: api.id, userId: friend.user.id, actions: ["services.deploy"] },
    { cookie: sharer.cookie },
  );
  expect(more.status).toBe(403);
  const everything = await call(
    panel,
    grantOps.setOnProject,
    { projectId: project.id, userId: friend.user.id, actions: ["*"] },
    { cookie: sharer.cookie },
  );
  expect(everything.status).toBe(403);
  const self = await call(
    panel,
    grantOps.setOnProject,
    { projectId: project.id, userId: sharer.user.id, actions: ["logs.view"] },
    { cookie: sharer.cookie },
  );
  expect(self.status).toBe(403);
  // A project with no grant at all: not even visible to the pipeline.
  const other = seedProject(panel);
  expect((await call(panel, grantOps.listByProject, { projectId: other.id }, { cookie: sharer.cookie })).status).toBe(403);
});

test("grants are for members; project-only actions cannot go on a service", async () => {
  const owner = await createUser(panel, "owner");
  const admin = await createUser(panel, "admin");
  const member = await createUser(panel, "member");
  const project = seedProject(panel);
  const api = seedService(panel, project.id);
  expect(
    (
      await call(
        panel,
        grantOps.setOnProject,
        { projectId: project.id, userId: admin.user.id, actions: ["services.view"] },
        { cookie: owner.cookie },
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        panel,
        grantOps.setOnService,
        { serviceId: api.id, userId: member.user.id, actions: ["projects.delete"] },
        { cookie: owner.cookie },
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        panel,
        grantOps.setOnProject,
        { projectId: "zzzzzzzzzzzzzzzz", userId: member.user.id, actions: ["services.view"] },
        { cookie: owner.cookie },
      )
    ).status,
  ).toBe(404);
});

test("area wildcards cover one area's actions", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const project = seedProject(panel);
  const api = seedService(panel, project.id);
  await ok(panel, grantOps.setOnService, { serviceId: api.id, userId: member.user.id, actions: ["services.*"] }, { cookie: owner.cookie });
  const access = createAccess(panel.deps.db, { type: "session", user: member.user, sessionId: "s" });
  expect(access.can("services.deploy", { type: "service", id: api.id })).toBe(true);
  expect(access.can("logs.view", { type: "service", id: api.id })).toBe(false);
});
