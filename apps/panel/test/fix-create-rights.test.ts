// services.create makes a service; its env (env.edit), its file mounts
// (files.write) and running it (services.deploy) are their own
// permissions, as services.clone and services.start already said. Before,
// a member granted only services.create could write a new service's env
// and file mounts and queue its first deployment through templates.create,
// dockerHub.create, compose.create, databases.create, boxes.create and
// services.create with deployNow.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { boxes as boxOps, compose, databases as dbOps, dockerHub, projects, services as serviceOps, templates } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { deployments, grants, services, volumes } from "../src/db/schema";
import { readServiceEnv } from "../src/modules/env/store";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let nodeA: string;
let projectId: string;
let owner: string;
let member: { cookie: string; user: { id: string } };
let environment: Record<string, string>;

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  environment = {};
  fleet.answers.set("parseCompose", () => ({
    projectJson: new TextEncoder().encode(JSON.stringify({ name: "s", services: { web: { image: "nginx:1.27", environment } } })),
    warnings: [],
  }));
  ({ cookie: owner } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie: owner })).body.id;
  member = await createUser(panel, "member");
  grant(panel, member.user.id, "project", projectId, ["services.create", "services.view"]);
});
afterEach(async () => {
  await fleet.settle();
  panel.close();
});

const allow = (actions: string[]) =>
  panel.deps.db
    .update(grants)
    .set({ actions: ["services.create", "services.view", ...actions] })
    .where(eq(grants.userId, member.user.id))
    .run();
const refusedFor = (res: { status: number; body: { error?: { details?: { action?: string } } } }) =>
  res.status === 403 ? (res.body.error?.details?.action ?? "403") : res.status;
const serviceNamed = (name: string) => panel.deps.db.select().from(services).where(eq(services.name, name)).get();
const inline = { type: "inline" as const, yaml: "services:\n  web:\n    image: nginx:1.27\n" };
const hub = (extra: Record<string, unknown>) => ({
  projectId,
  name: "hub",
  nodeId: nodeA,
  repository: "library/nginx",
  tag: "alpine",
  ...extra,
});

test("services.create alone makes services that do not run and carry no env", async () => {
  const cookie = member.cookie;
  // Before: 200, with a .env written and a deployment queued.
  expect(refusedFor(await callOp(panel, dockerHub.create, hub({ env: "FOO=bar" }), { cookie }))).toBe("env.edit");
  expect(refusedFor(await callOp(panel, dockerHub.create, hub({ env: "FOO=bar", deployNow: false }), { cookie }))).toBe("env.edit");
  expect(refusedFor(await callOp(panel, dockerHub.create, hub({}), { cookie }))).toBe("services.deploy");
  expect(
    refusedFor(await callOp(panel, serviceOps.create, { projectId, name: "api", kind: "app", nodeId: nodeA, deployNow: true }, { cookie })),
  ).toBe("services.deploy");
  expect(refusedFor(await callOp(panel, dbOps.create, { projectId, name: "pg", engine: "postgres", nodeId: nodeA }, { cookie }))).toBe(
    "services.deploy",
  );
  expect(refusedFor(await callOp(panel, boxOps.create, { projectId, name: "dev", nodeId: nodeA }, { cookie }))).toBe("services.deploy");
  environment = { TOKEN: "x" };
  expect(
    refusedFor(await callOp(panel, compose.create, { projectId, name: "s", nodeId: nodeA, source: inline, deployNow: false }, { cookie })),
  ).toBe("env.edit");
  environment = {};
  expect(refusedFor(await callOp(panel, compose.create, { projectId, name: "s", nodeId: nodeA, source: inline }, { cookie }))).toBe(
    "services.deploy",
  );
  for (const name of ["hub", "api", "pg", "dev", "s", "s-web"]) expect(serviceNamed(name)).toBeUndefined();

  // What it may do: a service that someone who can deploy starts later.
  expect((await callOp(panel, dockerHub.create, hub({ deployNow: false }), { cookie })).status).toBe(200);
  expect(
    (await callOp(panel, serviceOps.create, { projectId, name: "api", kind: "app", nodeId: nodeA, deployNow: false }, { cookie })).status,
  ).toBe(200);
  expect(
    (await callOp(panel, compose.create, { projectId, name: "s", nodeId: nodeA, source: inline, deployNow: false }, { cookie })).status,
  ).toBe(200);
  expect(panel.deps.db.select().from(deployments).all()).toHaveLength(0);

  // With the rights, the same calls go through.
  allow(["env.edit", "services.deploy"]);
  const deployed = await callOp(panel, dockerHub.create, hub({ name: "hub2", env: "FOO=bar" }), { cookie });
  expect(deployed.status).toBe(200);
  expect(readServiceEnv(panel.deps.db, panel.deps.secrets, deployed.body.id).text).toBe("FOO=bar\n");
  expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, deployed.body.id)).all()).toHaveLength(1);
});

test("templates need env.edit for their env, files.write for file mounts and services.deploy to start", async () => {
  const meta = `name: "Mounts"
description: "x"
category: "Other"
schema:
  type: object
  properties: {}
`;
  const source = `export function generate(input: { serviceName: string }) {
  return { services: [{ type: "app", data: {
    serviceName: input.serviceName,
    source: { type: "image", image: "nginx:1.27" },
    env: "GREETING=hi",
    mounts: [{ type: "file", mountPath: "/etc/app.conf", content: "x=1" }],
  } }] };
}`;
  expect((await callOp(panel, templates.saveCustom, { slug: "mounts", metaYaml: meta, source }, { cookie: owner })).status).toBe(200);
  const install = (deployNow: boolean) =>
    callOp(
      panel,
      templates.create,
      { projectId, slug: "mounts", name: "app", nodeId: nodeA, values: {}, deployNow },
      { cookie: member.cookie },
    );

  // Before: 200 with the env and the file mount written.
  expect(refusedFor(await install(false))).toBe("env.edit");
  allow(["env.edit"]);
  expect(refusedFor(await install(false))).toBe("files.write");
  allow(["env.edit", "files.write"]);
  expect(refusedFor(await install(true))).toBe("services.deploy");
  expect(serviceNamed("app")).toBeUndefined();
  const made = await install(false);
  expect(made.status).toBe(200);
  const app = serviceNamed("app");
  expect(
    panel.deps.db
      .select()
      .from(volumes)
      .where(eq(volumes.serviceId, app?.id as string))
      .all(),
  ).toHaveLength(1);
  expect(panel.deps.db.select().from(deployments).all()).toHaveLength(0);
});

test("compose.update needs env.edit to change members' env and services.deploy to roll them", async () => {
  allow(["services.update"]);
  const created = await callOp(
    panel,
    compose.create,
    { projectId, name: "s", nodeId: nodeA, source: inline, deployNow: false },
    { cookie: member.cookie },
  );
  expect(created.status).toBe(200);
  const serviceId = created.body.stack.id as string;
  const update = () => callOp(panel, compose.update, { serviceId, source: inline }, { cookie: member.cookie });

  environment = { TOKEN: "x" };
  // Before: 200, the member's .env rewritten and the member deployed.
  expect(refusedFor(await update())).toBe("env.edit");
  allow(["services.update", "env.edit"]);
  expect(refusedFor(await update())).toBe("services.deploy");
  expect(readServiceEnv(panel.deps.db, panel.deps.secrets, serviceNamed("s-web")?.id as string).text).toBe("");
  allow(["services.update", "env.edit", "services.deploy"]);
  expect((await update()).status).toBe(200);
  expect(readServiceEnv(panel.deps.db, panel.deps.secrets, serviceNamed("s-web")?.id as string).text).toBe("TOKEN=x\n");
});
