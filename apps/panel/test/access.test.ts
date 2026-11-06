import { afterEach, beforeEach, expect, test } from "bun:test";
import { permission } from "@seylo/ops";
import { createAccess } from "../src/auth/access";
import { projects, services } from "../src/db/schema";
import { createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

function seedService() {
  const project = panel.deps.db.insert(projects).values({ name: "p", nameKey: "p" }).returning().get();
  const service = panel.deps.db
    .insert(services)
    .values({ projectId: project.id, name: "api", nameKey: "api", kind: "app", spec: {} })
    .returning()
    .get();
  return { projectId: project.id, serviceId: service.id };
}

const deploy = permission.service("services.deploy", (input: { serviceId: string }) => input.serviceId);

test("a project grant covers the project's services", async () => {
  const { projectId, serviceId } = seedService();
  const { user } = await createUser(panel, "member");
  grant(panel, user.id, "project", projectId, ["services.deploy"]);
  const access = createAccess(panel.deps.db, { type: "session", user, sessionId: "s" });
  expect(access.require(deploy, "mutation", { serviceId })).toEqual({ type: "service", id: serviceId });
});

test("a service grant does not reach sibling services or other actions", async () => {
  const { projectId, serviceId } = seedService();
  const other = panel.deps.db.insert(services).values({ projectId, name: "web", nameKey: "web", kind: "app", spec: {} }).returning().get();
  const { user } = await createUser(panel, "member");
  grant(panel, user.id, "service", serviceId, ["services.deploy"]);
  const access = createAccess(panel.deps.db, { type: "session", user, sessionId: "s" });

  expect(access.can("services.deploy", { type: "service", id: serviceId })).toBe(true);
  expect(access.can("services.deploy", { type: "service", id: other.id })).toBe(false);
  expect(access.can("services.delete", { type: "service", id: serviceId })).toBe(false);
  expect(() => access.require(deploy, "mutation", { serviceId: other.id })).toThrow(/services.deploy/);
});

test("admins may do everything, anonymous callers nothing", async () => {
  const { serviceId } = seedService();
  const { user } = await createUser(panel, "admin");
  expect(
    createAccess(panel.deps.db, { type: "session", user, sessionId: "s" }).can("services.deploy", { type: "service", id: serviceId }),
  ).toBe(true);
  expect(() => createAccess(panel.deps.db, { type: "anonymous" }).require(deploy, "mutation", { serviceId })).toThrow(/Sign in/);
});
