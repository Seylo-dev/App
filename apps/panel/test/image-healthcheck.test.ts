// The image's own HEALTHCHECK (0.2.15): apps and compose members without a
// check of their own are sent HealthCheck.image from their next deploy, the
// default health timeout is left to the node (which waits longer for the
// image's start period), and what the node reports is kept with the
// deployment, waited for and shown on the service.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { durationFromMs } from "@bufbuild/protobuf/wkt";
import { compose, deployments as deploymentOps, projects, services as serviceOps } from "@seylo/ops";
import { DeployStage, ServiceKind } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { deployments, services } from "../src/db/schema";
import { planStack } from "../src/modules/compose/plan";
import { engineFor } from "../src/modules/deployments/engine";
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

async function createApp(name: string) {
  const res = await callOp(
    panel,
    serviceOps.create,
    {
      projectId,
      name,
      kind: "app",
      nodeId: nodeA,
      source: { type: "image", image: "ghcr.io/acme/api:1", registryId: null },
      ports: [{ containerPort: 3000, protocol: "tcp" }],
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

/** The node reports the rollout done, so the next deploy can start. */
async function goLive(serviceId: string, d: { generation: number }) {
  fleet.deployProgress(nodeA, serviceId, d.generation, DeployStage.SUCCEEDED);
  await fleet.settle();
}

const specOf = (id: string) => serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA);
const row = (id: string) => panel.deps.db.select().from(deployments).where(eq(deployments.id, id)).get();

// The api's HEALTHCHECK as an agent from 0.2.15 reports it.
const respoCheck = {
  test: ["CMD-SHELL", "bun run healthcheck"],
  interval: durationFromMs(10_000),
  timeout: durationFromMs(5_000),
  startPeriod: durationFromMs(600_000),
  startInterval: durationFromMs(5_000),
  retries: 3,
};

describe("the spec", () => {
  test("an app without a check of its own gets the image's check and no timeout while it keeps the default", async () => {
    const id = await createApp("api");
    await deploy(id);
    const spec = specOf(id);
    expect(spec?.healthCheck?.probe.case).toBe("image");
    expect(spec?.deploy?.healthTimeout).toBeUndefined();
  });

  test("a timeout the service set is sent as set, and a check of its own replaces the image's", async () => {
    const id = await createApp("api");
    const set = await callOp(
      panel,
      serviceOps.setHealthCheck,
      { serviceId: id, healthCheck: null, deploy: { mode: "rolling", healthTimeoutSeconds: 120 } },
      { cookie },
    );
    expect(set.status).toBe(200);
    await goLive(id, await deploy(id));
    expect(specOf(id)?.healthCheck?.probe.case).toBe("image");
    expect(Number(specOf(id)?.deploy?.healthTimeout?.seconds)).toBe(120);

    await callOp(
      panel,
      serviceOps.setHealthCheck,
      {
        serviceId: id,
        healthCheck: {
          probe: { type: "http", port: 3000, path: "/healthz", host: "", expectedStatus: 0 },
          intervalSeconds: 5,
          timeoutSeconds: 3,
          startPeriodSeconds: 10,
          failureThreshold: 3,
        },
      },
      { cookie },
    );
    await deploy(id);
    expect(specOf(id)?.healthCheck?.probe.case).toBe("http");
  });

  test("a generation deployed before 0.2.15 keeps the TCP default until the next deploy", async () => {
    const id = await createApp("api");
    const d = await deploy(id);
    // A snapshot from before: no imageHealthCheck key.
    const { imageHealthCheck: _, ...old } = row(d.id)?.runSettings ?? {};
    panel.deps.db.update(deployments).set({ runSettings: old }).where(eq(deployments.id, d.id)).run();
    expect(specOf(id)?.healthCheck).toBeUndefined();
    await goLive(id, d);
    await deploy(id);
    expect(specOf(id)?.healthCheck?.probe.case).toBe("image");
  });

  test("the panel and databases never get it", async () => {
    const db = await callOp(
      panel,
      serviceOps.create,
      {
        projectId,
        name: "cronjob",
        kind: "cron",
        nodeId: nodeA,
        source: { type: "image", image: "busybox:1.37", registryId: null },
        cron: { schedule: "0 3 * * *", timeZone: "UTC", command: ["true"], timeoutSeconds: 60, concurrency: "forbid" },
      },
      { cookie },
    );
    expect(db.status).toBe(200);
    await deploy(db.body.id);
    expect(specOf(db.body.id)?.healthCheck).toBeUndefined();

    const id = await createApp("api");
    await deploy(id);
    panel.deps.db.update(services).set({ protected: true }).where(eq(services.id, id)).run();
    expect(specOf(id)?.healthCheck).toBeUndefined();
  });

  test("compose members: the file's own check wins, and a file that turns checks off gets none", async () => {
    fleet.answers.set("parseCompose", () => ({
      projectJson: new TextEncoder().encode(
        JSON.stringify({
          name: "stack",
          services: {
            api: { image: "ghcr.io/acme/api:1" },
            web: { image: "ghcr.io/acme/web:1", healthcheck: { test: ["CMD", "wget", "-q", "-O-", "localhost/healthz"], retries: 3 } },
            worker: { image: "ghcr.io/acme/worker:1", healthcheck: { disable: true } },
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
    const api = specOf(byName.get("stack-api") as string);
    expect(api?.kind).toBe(ServiceKind.COMPOSE_MEMBER);
    expect(api?.healthCheck?.probe.case).toBe("image");
    expect(specOf(byName.get("stack-web") as string)?.healthCheck?.probe.case).toBe("command");
    expect(specOf(byName.get("stack-worker") as string)?.healthCheck).toBeUndefined();
  });

  test("a plan keeps members from before unchanged and marks only files that turn checks off", () => {
    const plan = planStack(
      "s",
      { services: { a: { image: "x:1" }, b: { image: "x:1", healthcheck: { test: ["NONE"] } } } },
      { type: "inline", yaml: "" },
    );
    expect(plan.members.map((m) => [m.composeService, m.imageHealthCheck])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });
});

describe("what the node reports", () => {
  test("is kept with the deployment, waited for past the default and shown on the service", async () => {
    const id = await createApp("api");
    const d = await deploy(id);
    fleet.deployProgress(nodeA, id, d.generation, DeployStage.HEALTH_CHECKING, "waiting for the image's HEALTHCHECK", {
      imageHealthCheck: respoCheck,
      healthTimeout: durationFromMs(705_000),
    });
    await fleet.settle();
    expect(row(d.id)?.nodeResults[nodeA]).toMatchObject({
      status: "pending",
      healthWaitSeconds: 705,
      imageHealthCheck: { test: respoCheck.test, intervalSeconds: 10, timeoutSeconds: 5, startPeriodSeconds: 600, retries: 3 },
    });

    // 11 minutes in: past the panel's own 300 s + 5 min grace, inside the node's 705 s + grace.
    panel.deps.db
      .update(deployments)
      .set({ phaseStartedAt: new Date(Date.now() - 660_000) })
      .where(eq(deployments.id, d.id))
      .run();
    engineFor(panel.deps).kick(d.id);
    await fleet.settle();
    expect(row(d.id)?.status).toBe("deploying");

    fleet.deployProgress(nodeA, id, d.generation, DeployStage.SUCCEEDED, "", { imageHealthCheck: respoCheck });
    await fleet.settle();
    expect(row(d.id)?.status).toBe("live");
    const svc = (await callOp(panel, serviceOps.get, { serviceId: id }, { cookie })).body;
    expect(svc.healthCheck).toBeNull();
    expect(svc.imageHealthCheck).toEqual({
      test: ["CMD-SHELL", "bun run healthcheck"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      startPeriodSeconds: 600,
      retries: 3,
    });
  });

  test("without a report the panel keeps its own deadline, and a service never deployed shows none", async () => {
    const id = await createApp("api");
    expect((await callOp(panel, serviceOps.get, { serviceId: id }, { cookie })).body.imageHealthCheck).toBeNull();
    const d = await deploy(id);
    panel.deps.db
      .update(deployments)
      .set({ phaseStartedAt: new Date(Date.now() - 660_000) })
      .where(eq(deployments.id, d.id))
      .run();
    engineFor(panel.deps).kick(d.id);
    await fleet.settle();
    expect(row(d.id)?.status).toBe("failed");
    expect(row(d.id)?.error).toContain("did not report the new version healthy within 600s");
  });
});
