// The init process (0.2.14): apps, compose members and cron services run
// Docker's init by default (container.init "auto"), from their next deploy;
// a deployment from before keeps no init, so nothing running is made again
// on a panel update. Databases, Boxes and the panel never get one.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compose, databases as dbOps, deployments as deploymentOps, projects, services as serviceOps } from "@seylo/ops";
import { DeployStage, InitMode } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { deployments, services } from "../src/db/schema";
import { planStack } from "../src/modules/compose/plan";
import { serviceSpecFor } from "../src/modules/services/desired";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let nodeA: string;

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "respo" }, { cookie })).body.id;
});
afterEach(() => panel.close());

async function createApp(name: string, kind: "app" | "cron" = "app") {
  const res = await callOp(
    panel,
    serviceOps.create,
    {
      projectId,
      name,
      kind,
      nodeId: nodeA,
      source: { type: "image", image: "ghcr.io/acme/api:1", registryId: null },
      ...(kind === "cron"
        ? { cron: { schedule: "0 3 * * *", timeZone: "UTC", command: ["true"], timeoutSeconds: 60, concurrency: "forbid" as const } }
        : { ports: [{ containerPort: 3000, protocol: "tcp" as const }] }),
    },
    { cookie },
  );
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function deploy(serviceId: string) {
  const res = await callOp(panel, deploymentOps.deploy, { serviceId }, { cookie });
  expect(res.status).toBe(200);
  await fleet.settle();
  const row = panel.deps.db.select().from(deployments).where(eq(deployments.id, res.body.id)).get();
  return { id: res.body.id as string, generation: row?.generation as number };
}

async function goLive(serviceId: string, d: { generation: number }) {
  fleet.deployProgress(nodeA, serviceId, d.generation, DeployStage.SUCCEEDED);
  await fleet.settle();
}

const initOf = (id: string) => serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.container?.init;

describe("the setting", () => {
  test("is auto by default, set with services.update and applies on the next deploy", async () => {
    const id = await createApp("api");
    const got = await callOp(panel, serviceOps.get, { serviceId: id }, { cookie });
    expect(got.body.container.init).toBe("auto");

    const first = await deploy(id);
    expect(initOf(id)).toBe(InitMode.AUTO);
    await goLive(id, first);

    const set = await callOp(panel, serviceOps.update, { serviceId: id, container: { init: "off" } }, { cookie });
    expect(set.status).toBe(200);
    expect(set.body.container.init).toBe("off");
    // The other container settings stay.
    expect(set.body.container.stopGraceSeconds).toBe(10);
    // Waits for the next deploy.
    expect(initOf(id)).toBe(InitMode.AUTO);
    await deploy(id);
    expect(initOf(id)).toBe(InitMode.OFF);

    const on = await callOp(panel, serviceOps.update, { serviceId: id, container: { init: "on" } }, { cookie });
    expect(on.body.container.init).toBe("on");
    const bad = await callOp(panel, serviceOps.update, { serviceId: id, container: { init: "tini" } } as never, { cookie });
    expect(bad.status).toBe(400);
  });

  test("a deployment from before 0.2.14 keeps no init, so its containers are not made again", async () => {
    const id = await createApp("api");
    const d = await deploy(id);
    const settings = panel.deps.db.select().from(deployments).where(eq(deployments.id, d.id)).get()?.runSettings ?? {};
    const { init: _, ...container } = settings.container as Record<string, unknown>;
    panel.deps.db
      .update(deployments)
      .set({ runSettings: { ...settings, container } })
      .where(eq(deployments.id, d.id))
      .run();
    expect(initOf(id)).toBe(InitMode.UNSPECIFIED);
    // A service row from before (no init key) snapshots auto on its next deploy.
    const row = panel.deps.db.select().from(services).where(eq(services.id, id)).get();
    const stored = row?.spec as { container?: Record<string, unknown> } | undefined;
    expect(stored?.container?.init).toBeUndefined();
    await goLive(id, d);
    await deploy(id);
    expect(initOf(id)).toBe(InitMode.AUTO);
  });

  test("cron services get it; databases and the panel never do", async () => {
    const cron = await createApp("nightly", "cron");
    await deploy(cron);
    expect(initOf(cron)).toBe(InitMode.AUTO);

    const db = await callOp(panel, dbOps.create, { projectId, name: "pg", engine: "postgres", nodeId: nodeA } as never, { cookie });
    expect(db.status).toBe(200);
    await fleet.settle();
    const dbSpec = serviceSpecFor(panel.deps.db, panel.deps.secrets, db.body.serviceId, nodeA);
    expect(dbSpec).not.toBeNull();
    expect(dbSpec?.container?.init).toBe(InitMode.UNSPECIFIED);

    const id = await createApp("api");
    await deploy(id);
    panel.deps.db.update(services).set({ protected: true }).where(eq(services.id, id)).run();
    expect(initOf(id)).toBe(InitMode.UNSPECIFIED);
  });
});

describe("compose members", () => {
  test("the file's init: wins, and without one the default is auto", async () => {
    fleet.answers.set("parseCompose", () => ({
      projectJson: new TextEncoder().encode(
        JSON.stringify({
          name: "stack",
          services: {
            api: { image: "ghcr.io/acme/api:1", init: true },
            lsio: { image: "lscr.io/linuxserver/app:1", init: false },
            web: { image: "ghcr.io/acme/web:1" },
          },
        }),
      ),
      warnings: [],
    }));
    const res = await callOp(
      panel,
      compose.create,
      { projectId, name: "stack", nodeId: nodeA, source: { type: "inline", yaml: "services: {}\n" } },
      { cookie },
    );
    expect(res.status).toBe(200);
    await fleet.settle();
    const byName = new Map((res.body.members as { id: string; name: string }[]).map((m) => [m.name, m.id]));
    expect(initOf(byName.get("stack-api") as string)).toBe(InitMode.ON);
    expect(initOf(byName.get("stack-lsio") as string)).toBe(InitMode.OFF);
    expect(initOf(byName.get("stack-web") as string)).toBe(InitMode.AUTO);
  });

  test("a plan without init: leaves the key out, so members from before compare unchanged", () => {
    const plan = planStack("s", { services: { a: { image: "x:1" }, b: { image: "x:1", init: true } } }, { type: "inline", yaml: "" });
    expect("init" in (plan.members[0]?.container ?? {})).toBe(false);
    expect(plan.members[1]?.container.init).toBe("on");
  });
});
