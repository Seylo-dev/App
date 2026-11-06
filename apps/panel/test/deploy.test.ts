import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deployments as deploymentOps, projects, services as serviceOps } from "@seylo/ops";
import { DeployStage, ServiceKind } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { alerts, deployments, nodes, services } from "../src/db/schema";
import { registryGcSweepJob, registryGcSweepJobType, servicesWithPrunableImages } from "../src/modules/deployments/registry-gc";
import { networkingContributor } from "../src/modules/domains/contributor";
import { writeServiceEnv } from "../src/modules/env/store";
import { serviceSpecFor } from "../src/modules/services/desired";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let nodeA: string;
let builder: string;

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  builder = fleet.addNode("builder", { canBuild: true, panelNode: true });
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
});
afterEach(() => panel.close());

async function createApp(name: string, source: unknown, extra: Record<string, unknown> = {}) {
  const res = await callOp(
    panel,
    serviceOps.create,
    { projectId, name, kind: "app", nodeId: nodeA, source, ports: [{ containerPort: 3000, protocol: "tcp" }], ...extra } as never,
    {
      cookie,
    },
  );
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function deploy(serviceId: string) {
  const res = await callOp(panel, deploymentOps.deploy, { serviceId }, { cookie });
  expect(res.status).toBe(200);
  await fleet.settle();
  return res.body.id as string;
}

async function getDeployment(serviceId: string, deploymentId: string) {
  return (await callOp(panel, deploymentOps.get, { serviceId, deploymentId }, { cookie })).body.deployment;
}

const inline = { type: "inline" };
const setDockerfile = (serviceId: string) =>
  panel.deps.db
    .update(services)
    .set({
      spec: {
        ...(panel.deps.db.select().from(services).where(eq(services.id, serviceId)).get()?.spec as object),
        build: { builder: "dockerfile", inlineDockerfile: "FROM nginx:1.27\n" },
      },
    })
    .where(eq(services.id, serviceId))
    .run();

describe("deploys", () => {
  test("an image service deploys without a build and goes live when the node reports success", async () => {
    const id = await createApp("web", { type: "image", image: "nginx:1.27", registryId: null });
    const depId = await deploy(id);

    let d = await getDeployment(id, depId);
    expect(d.status).toBe("deploying");
    expect(d.steps.map((s: { status: string }) => s.status)).toEqual(["skipped", "skipped", "running", "pending", "pending"]);
    expect(fleet.builds).toHaveLength(0);

    // The service now targets the deployment, so the compiler sends its image to the node.
    const spec = serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA);
    expect(spec?.image?.reference).toBe("nginx:1.27");
    expect(spec?.kind).toBe(ServiceKind.APP);
    expect(spec?.ports[0]?.containerPort).toBe(3000);
    expect(spec?.generation).toBe(BigInt(d.generation));

    fleet.deployProgress(nodeA, id, d.generation, DeployStage.HEALTH_CHECKING, "GET / 200");
    fleet.deployProgress(nodeA, id, d.generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    d = await getDeployment(id, depId);
    expect(d.status).toBe("live");
    expect(d.live).toBe(true);
    expect(d.steps.every((s: { status: string }) => s.status === "ok" || s.status === "skipped")).toBe(true);

    const svc = (await callOp(panel, serviceOps.get, { serviceId: id }, { cookie })).body;
    expect(svc.liveDeployment.id).toBe(depId);
    expect(svc.liveDeployment.label).toBe("1.27");

    // The digest the node reports later is recorded for rollbacks without
    // changing the running spec (that would roll the service again).
    const digest = `sha256:${"c".repeat(64)}`;
    fleet.reportRunning(nodeA, id, d.generation, digest);
    await fleet.settle();
    expect((await getDeployment(id, depId)).image.digest).toBe(digest);
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.image?.digest).toBe("");
  });

  test("a source build runs on a node that can build, ships by digest, and logs the build", async () => {
    const id = await createApp("api", inline);
    setDockerfile(id);
    writeServiceEnv(panel.deps.db, panel.deps.secrets, id, "NODE_ENV=production\n", null);
    const depId = await deploy(id);

    expect(fleet.builds).toHaveLength(1);
    expect(fleet.builds[0]?.nodeId).toBe(builder);
    expect(fleet.builds[0]?.request).toMatchObject({ env: [{ name: "NODE_ENV", value: "production" }], projectId });
    let d = await getDeployment(id, depId);
    expect(d.status).toBe("deploying");
    expect(d.builtOn).toEqual({ id: builder, name: "builder" });
    expect(d.builder).toBe("dockerfile");
    expect(d.image.reference).toBe(`127.0.0.1:5755/${id}:${d.generation}`);
    expect(d.image.digest).toBe(`sha256:${"a".repeat(64)}`);

    const log = (await callOp(panel, deploymentOps.log, { serviceId: id, deploymentId: depId }, { cookie })).body;
    expect(log.lines.map((l: { text: string }) => l.text)).toContain("#1 building");
    expect(log.done).toBe(false);

    // A lost DeployProgress is covered by the node's reported state.
    fleet.reportRunning(nodeA, id, d.generation, d.image.digest);
    await fleet.settle();
    d = await getDeployment(id, depId);
    expect(d.status).toBe("live");
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.image?.digest).toBe(`sha256:${"a".repeat(64)}`);
  });

  test("log lines stream on the deployment's live topic", async () => {
    const id = await createApp("api", inline);
    setDockerfile(id);
    const received: { event: { type: string; lines?: { text: string }[]; deployment?: { status: string; steps: unknown[] } } }[] = [];
    const res = await callOp(panel, deploymentOps.deploy, { serviceId: id }, { cookie });
    panel.deps.live.subscribe({ id: "tab", send: (m) => received.push(m as never) }, `deployment:${res.body.id}`);
    await fleet.settle();
    const lines = received
      .filter((m) => m.event.type === "log")
      .flatMap((m) => m.event.lines ?? [])
      .map((l) => l.text);
    expect(lines).toContain("#2 done");
    // Status changes ride the same topic, as whole deployments.
    const statuses = received.filter((m) => m.event.type === "deployment").map((m) => m.event.deployment?.status);
    expect(statuses).toContain("building");
    expect(statuses.at(-1)).toBe((await getDeployment(id, res.body.id)).status);
    const get = await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: res.body.id }, { cookie });
    expect(get.body.logTopic).toBe(`deployment:${res.body.id}`);
  });

  test("a failed build fails the deployment and nothing changes on the node", async () => {
    const id = await createApp("api", inline);
    setDockerfile(id);
    fleet.buildScript = () => ({ logs: ["npm ERR! missing script: build"], result: "failed", message: "exit code 1" });
    const depId = await deploy(id);
    const d = await getDeployment(id, depId);
    expect(d.status).toBe("failed");
    expect(d.error).toContain("exit code 1");
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)).toBeNull();
    const svc = panel.deps.db.select().from(services).where(eq(services.id, id)).get();
    expect(svc?.targetDeploymentId).toBeNull();
  });

  test("an unhealthy rollout fails and the target goes back to the live version", async () => {
    const id = await createApp("web", { type: "image", image: "nginx:1.27", registryId: null });
    const first = await deploy(id);
    const g1 = (await getDeployment(id, first)).generation;
    fleet.deployProgress(nodeA, id, g1, DeployStage.SUCCEEDED);
    await fleet.settle();

    await callOp(
      panel,
      serviceOps.setSource,
      { serviceId: id, source: { type: "image", image: "nginx:broken", registryId: null } },
      { cookie },
    );
    const second = await deploy(id);
    const g2 = (await getDeployment(id, second)).generation;
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.image?.reference).toBe("nginx:broken");
    fleet.deployProgress(nodeA, id, g2, DeployStage.FAILED, "No answer on port 3000 within 60s.");
    await fleet.settle();

    const d2 = await getDeployment(id, second);
    expect(d2.status).toBe("failed");
    expect(d2.error).toContain("previous version stayed live");
    const spec = serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA);
    expect(spec?.image?.reference).toBe("nginx:1.27");
    expect(spec?.generation).toBe(BigInt(g1));
    expect((await getDeployment(id, first)).status).toBe("live");
  });

  test("a failed deploy leaves the live version on the env it started with", async () => {
    const id = await createApp("web", { type: "image", image: "nginx:1.27", registryId: null });
    const envOf = () => {
      const svc = panel.deps.db.select().from(services).where(eq(services.id, id)).get();
      const spec = serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA);
      if (!svc || !spec) throw new Error("no spec");
      networkingContributor.service?.({ db: panel.deps.db, secrets: panel.deps.secrets, nodeId: nodeA, service: svc, spec });
      return Object.fromEntries(spec.env.map((v) => [v.name, v.value]));
    };
    writeServiceEnv(panel.deps.db, panel.deps.secrets, id, "NAME=v1\n", null);
    const first = await deploy(id);
    const g1 = (await getDeployment(id, first)).generation;
    fleet.deployProgress(nodeA, id, g1, DeployStage.SUCCEEDED);
    await fleet.settle();
    expect(envOf().NAME).toBe("v1");

    // Saved but not deployed: the live version keeps its env.
    writeServiceEnv(panel.deps.db, panel.deps.secrets, id, "NAME=v2-broken\n", null);
    expect(envOf().NAME).toBe("v1");

    const second = await deploy(id);
    const g2 = (await getDeployment(id, second)).generation;
    expect(envOf().NAME).toBe("v2-broken");
    fleet.deployProgress(nodeA, id, g2, DeployStage.FAILED, "No answer on port 3000 within 60s.");
    await fleet.settle();
    expect((await getDeployment(id, second)).status).toBe("failed");
    expect(envOf().NAME).toBe("v1");
  });

  test("rollback deploys an earlier image without building", async () => {
    const id = await createApp("api", inline);
    setDockerfile(id);
    const first = await deploy(id);
    fleet.reportRunning(nodeA, id, (await getDeployment(id, first)).generation);
    await fleet.settle();
    fleet.buildScript = () => ({ result: "succeeded", digest: `sha256:${"b".repeat(64)}` });
    const second = await deploy(id);
    fleet.reportRunning(nodeA, id, (await getDeployment(id, second)).generation);
    await fleet.settle();
    expect((await getDeployment(id, first)).status).toBe("superseded");
    expect((await getDeployment(id, first)).canRollback).toBe(true);
    expect(fleet.builds).toHaveLength(2);

    const rb = await callOp(panel, deploymentOps.rollback, { serviceId: id, deploymentId: first }, { cookie });
    expect(rb.status).toBe(200);
    await fleet.settle();
    expect(fleet.builds).toHaveLength(2);
    expect(rb.body.trigger).toBe("rollback");
    expect(rb.body.rollbackOf).toBe(first);
    const spec = serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA);
    expect(spec?.image?.digest).toBe(`sha256:${"a".repeat(64)}`);
    fleet.reportRunning(nodeA, id, Number(spec?.generation));
    await fleet.settle();
    expect((await getDeployment(id, rb.body.id)).status).toBe("live");
    expect((await getDeployment(id, second)).status).toBe("superseded");

    const listed = (await callOp(panel, deploymentOps.list, { serviceId: id }, { cookie })).body;
    expect(listed.deployments.map((d: { id: string }) => d.id)).toEqual([rb.body.id, second, first]);
    expect(listed.keptImages).toBe(5);
  });

  test("deploys of one service queue behind each other, and a queued one can be cancelled", async () => {
    const id = await createApp("api", inline);
    setDockerfile(id);
    fleet.buildScript = () => ({ result: "hang" });
    const first = await deploy(id);
    const second = await deploy(id);
    expect((await getDeployment(id, first)).status).toBe("building");
    expect((await getDeployment(id, second)).status).toBe("queued");

    const cancelled = await callOp(panel, deploymentOps.cancel, { serviceId: id, deploymentId: second }, { cookie });
    expect(cancelled.body.status).toBe("cancelled");
    const stopBuild = await callOp(panel, deploymentOps.cancel, { serviceId: id, deploymentId: first }, { cookie });
    expect(stopBuild.body.status).toBe("cancelled");
    expect(fleet.calls.some((c) => c.method === "cancelBuild")).toBe(true);
    await fleet.settle();
  });

  test("a dropped build stream is followed again; the build keeps its id", async () => {
    const id = await createApp("api", inline);
    setDockerfile(id);
    fleet.buildScript = () => ({ result: "hang" });
    const depId = await deploy(id);
    for (const drop of fleet.drops.splice(0)) drop();
    await fleet.settle();
    const opens = fleet.calls.filter((c) => c.method === "build").map((c) => (c.request as { buildId: string }).buildId);
    expect(opens).toHaveLength(2);
    expect(opens[0]).toBe(opens[1] as string);
    expect((await getDeployment(id, depId)).status).toBe("building");
    const log = (await callOp(panel, deploymentOps.log, { serviceId: id, deploymentId: depId }, { cookie })).body.lines.map(
      (l: { text: string }) => l.text,
    );
    expect(log.some((t: string) => t.includes("Lost the connection"))).toBe(true);
    for (const drop of fleet.drops.splice(0)) drop();
    await fleet.settle();
  });

  test("recent deployments across services, filtered by access", async () => {
    const a = await createApp("a", { type: "image", image: "nginx:1", registryId: null });
    const b = await createApp("b", { type: "image", image: "nginx:2", registryId: null });
    await deploy(a);
    await deploy(b);
    const all = await callOp(panel, deploymentOps.recent, {}, { cookie });
    expect(all.body.deployments.map((d: { serviceName: string }) => d.serviceName)).toEqual(["b", "a"]);
    const { user, cookie: memberCookie } = await createUser(panel, "member");
    grant(panel, user.id, "service", a, ["services.view"]);
    const mine = await callOp(panel, deploymentOps.recent, { limit: 10 }, { cookie: memberCookie });
    expect(mine.body.deployments.map((d: { serviceName: string; projectId: string }) => [d.serviceName, d.projectId])).toEqual([
      ["a", projectId],
    ]);
  });

  test("images outside the rollback history are deleted from the panel registry", async () => {
    const id = await createApp("api", inline);
    setDockerfile(id);
    let n = 0;
    fleet.buildScript = () => ({ result: "succeeded", digest: `sha256:${String(++n).padStart(64, "0")}` });
    for (let i = 0; i < 7; i++) {
      const depId = await deploy(id);
      fleet.reportRunning(nodeA, id, (await getDeployment(id, depId)).generation);
      await fleet.settle();
    }
    await panel.runner.runDue(panel.deps);
    expect(fleet.registryRequests).toEqual([
      `DELETE /v2/${id}/manifests/sha256:${"1".padStart(64, "0")} HTTP/1.1`,
      `DELETE /v2/${id}/manifests/sha256:${"2".padStart(64, "0")} HTTP/1.1`,
    ]);
    const listed = (await callOp(panel, deploymentOps.list, { serviceId: id }, { cookie })).body.deployments;
    expect(listed.filter((d: { canRollback: boolean }) => d.canRollback)).toHaveLength(4);

    // Deleting the service deletes its remaining images.
    fleet.registryRequests.length = 0;
    await callOp(panel, serviceOps.remove, { serviceId: id, confirmName: "api" }, { cookie });
    await panel.runner.runDue(panel.deps);
    expect(fleet.registryRequests).toHaveLength(5);
  });

  test("a daily sweep retries image deletes that the deploy-time run missed", async () => {
    const id = await createApp("api", inline);
    setDockerfile(id);
    let n = 0;
    fleet.buildScript = () => ({ result: "succeeded", digest: `sha256:${String(++n).padStart(64, "0")}` });
    for (let i = 0; i < 7; i++) {
      const depId = await deploy(id);
      fleet.reportRunning(nodeA, id, (await getDeployment(id, depId)).generation);
      await fleet.settle();
    }
    await panel.runner.runDue(panel.deps);
    // As if those deletes never reached the registry (panel node offline at the time).
    panel.deps.db.update(deployments).set({ imagePrunedAt: null }).run();
    fleet.registryRequests.length = 0;
    expect(servicesWithPrunableImages(panel.deps)).toEqual([id]);
    await registryGcSweepJob.run({}, panel.deps as never);
    await panel.runner.runDue(panel.deps);
    expect(fleet.registryRequests).toHaveLength(2);
    expect(servicesWithPrunableImages(panel.deps)).toEqual([]);
    expect(panel.deps.schedules.get(registryGcSweepJobType)).not.toBeNull();
  });

  test("builds wait for nothing when the panel registry is offline: they fail at once", async () => {
    fleet.online.delete(builder);
    fleet.addNode("other-builder", { canBuild: true });
    const id = await createApp("api", inline);
    setDockerfile(id);
    const d = await getDeployment(id, await deploy(id));
    expect(d.status).toBe("failed");
    expect(d.error).toContain("image registry is on builder, which is offline");
    expect(fleet.builds).toHaveLength(0);
  });

  test("no node that can build fails clearly", async () => {
    // The registry lives on node-a here, so only the builder is missing.
    panel.deps.db.update(nodes).set({ isPanelNode: false }).where(eq(nodes.id, builder)).run();
    panel.deps.db.update(nodes).set({ isPanelNode: true }).where(eq(nodes.id, nodeA)).run();
    fleet.online.delete(builder);
    const id = await createApp("api", inline);
    setDockerfile(id);
    const depId = await deploy(id);
    const d = await getDeployment(id, depId);
    expect(d.status).toBe("failed");
    expect(d.error).toContain("Can build");
    const raised = panel.deps.db.select().from(alerts).all();
    // Nothing was built or shipped: it is a build failure.
    expect(raised.map((a) => [a.event, a.serviceId])).toEqual([["build_failed", id]]);
  });

  test("a build the agent fails alerts once, as build_failed", async () => {
    const id = await createApp("api", inline);
    setDockerfile(id);
    fleet.buildScript = () => ({ logs: ["boom"], result: "failed", message: "exit code 2" });
    const d = await getDeployment(id, await deploy(id));
    expect(d.status).toBe("failed");
    const raised = panel.deps.db.select().from(alerts).all();
    expect(raised.map((a) => a.event)).toEqual(["build_failed"]);
    expect(raised[0]?.eventKey).toStartWith("build-failed:");
  });
});
