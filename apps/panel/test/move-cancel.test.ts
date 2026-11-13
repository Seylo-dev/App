// Cancelling a move to another node (deployments.cancel of a services.move
// deployment, 0.2.17) on a fake fleet. A move with volumes is cancelled
// only while it copies: the copy's streams close first (ExportVolume on
// the old node, ImportVolume on the new one) or its wait for the old copy
// to stop ends, and only then the service goes back to the old node and
// starts there, with its data, while the new node loses its placement and
// the partial copy with it. Once the copy is done and the new node starts
// it, a cancel is refused (reason moveStarting). A move without volumes is
// cancelled like any deploy: the old copy kept serving. Deployment.move
// says where it goes, whether it copies and whether a cancel is taken.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deployments as deploymentOps, projects, services as serviceOps } from "@seylo/ops";
import { DeployStage, ServicePhase } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { deployments, servicePlacements, services } from "../src/db/schema";
import { serviceSpecFor } from "../src/modules/services/desired";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let email: string;
let projectId: string;
let nodeA: string;
let nodeB: string;

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  nodeB = fleet.addNode("node-b");
  ({ cookie } = await createUser(panel, "owner", "owner@example.com"));
  email = "owner@example.com";
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
});
afterEach(() => panel.close());

const bytes = (text: string) => new TextEncoder().encode(text);

/** A live image app on node A, with these volumes. */
async function liveApp(name: string, volumes: { name: string; mountPath: string }[] = []) {
  const id = (
    await callOp(
      panel,
      serviceOps.create,
      {
        projectId,
        name,
        kind: "app",
        nodeId: nodeA,
        source: { type: "image", image: "redis:7", registryId: null },
        ports: [{ containerPort: 6379, protocol: "tcp" }],
      },
      { cookie },
    )
  ).body.id as string;
  if (volumes.length > 0) expect((await callOp(panel, serviceOps.setVolumes, { serviceId: id, volumes }, { cookie })).status).toBe(200);
  const dep = (await callOp(panel, deploymentOps.deploy, { serviceId: id }, { cookie })).body;
  await fleet.settle();
  fleet.deployProgress(nodeA, id, dep.generation, DeployStage.SUCCEEDED);
  await fleet.settle();
  return id;
}

const placed = (serviceId: string) =>
  panel.deps.db
    .select({ nodeId: servicePlacements.nodeId })
    .from(servicePlacements)
    .where(eq(servicePlacements.serviceId, serviceId))
    .all()
    .map((p) => p.nodeId)
    .sort();

const specOn = (serviceId: string, nodeId: string) => serviceSpecFor(panel.deps.db, panel.deps.secrets, serviceId, nodeId);
const rowOf = (deploymentId: string) => panel.deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();

async function viewOf(serviceId: string, deploymentId: string) {
  return (await callOp(panel, deploymentOps.get, { serviceId, deploymentId }, { cookie })).body.deployment;
}

async function logOf(serviceId: string, deploymentId: string): Promise<string[]> {
  const res = await callOp(panel, deploymentOps.log, { serviceId, deploymentId }, { cookie });
  return (res.body.lines as { text: string }[]).map((l) => l.text);
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await Bun.sleep(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Records, when the panel cancels one of its copy streams, where the
 * service is placed and whether the old copy is still stopped then.
 */
function watchCancels(serviceId: string) {
  const seen: { stream: string; placed: string[]; oldStopped: boolean | undefined }[] = [];
  const openRaw = fleet.hub.openRaw.bind(fleet.hub);
  fleet.hub.openRaw = ((nodeId: string, method: string, request: unknown) => {
    const raw = openRaw(nodeId as never, method as never, request as never) as { cancel(reason?: string): void };
    const cancel = raw.cancel.bind(raw);
    let first = true;
    raw.cancel = (reason?: string) => {
      if (first) seen.push({ stream: method, placed: placed(serviceId), oldStopped: specOn(serviceId, nodeA)?.stopped });
      first = false;
      cancel(reason);
    };
    return raw;
  }) as typeof fleet.hub.openRaw;
  return seen;
}

describe("cancelling a move with volumes", () => {
  test("while it copies: the copy stops first, then the old copy runs again with its data and the new one goes", async () => {
    const id = await liveApp("cache", [{ name: "data", mountPath: "/data" }]);
    fleet.volumes.set(nodeA, new Map([[`${id}/data`, bytes("tar.gz bytes of the volume")]]));
    fleet.reportRunning(nodeA, id, 1, "", ServicePhase.STOPPED);
    // The export hands out its bytes and then waits, as on a big volume: the copy is halfway when the cancel comes.
    fleet.volumeScript = () => ({ hang: true });
    const cancels = watchCancels(id);
    const res = await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie });
    expect(res.status).toBe(200);
    const deploymentId = res.body.deploymentId as string;
    expect((await viewOf(id, deploymentId)).move).toEqual({
      from: { id: nodeA, name: "node-a" },
      to: { id: nodeB, name: "node-b" },
      copying: true,
      canCancel: true,
    });

    const job = panel.runner.runDue(panel.deps);
    await until(() => fleet.calls.some((c) => c.nodeId === nodeB && c.method === "importVolume"), "the copy to start");
    expect(placed(id)).toEqual([nodeA, nodeB].sort());
    expect(specOn(id, nodeA)?.stopped).toBe(true);

    const cancelled = await callOp(panel, deploymentOps.cancel, { serviceId: id, deploymentId }, { cookie });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", error: null, move: { copying: false, canCancel: false } });
    // Both streams were closed while the service was still on both nodes and stopped: nothing reads or
    // writes its folders once it goes back.
    expect(cancels.map((c) => c.stream).sort()).toEqual(["exportVolume", "importVolume"]);
    for (const c of cancels) expect(c).toMatchObject({ placed: [nodeA, nodeB].sort(), oldStopped: true });
    expect([...fleet.cancelled].sort()).toEqual([`exportVolume ${id}/data`, `importVolume ${id}/data`]);

    // The old copy runs again with its data; the new node has no placement, so it drops the partial copy.
    expect(placed(id)).toEqual([nodeA]);
    expect(specOn(id, nodeA)?.stopped).toBe(false);
    expect(specOn(id, nodeB)).toBeNull();
    expect(new TextDecoder().decode(fleet.volumes.get(nodeA)?.get(`${id}/data`))).toBe("tar.gz bytes of the volume");
    expect(panel.deps.db.select({ stopped: services.stopped }).from(services).where(eq(services.id, id)).get()?.stopped).toBe(false);
    const lines = await logOf(id, deploymentId);
    expect(lines).toContain("Stopped the copy to node-b. cache starts again on node-a with its data, and node-b removes what was copied.");
    expect(lines).toContain(`Cancelled by ${email}.`);

    // The job ended with it, and nothing it did afterwards turned the cancel into a failure.
    await job;
    await fleet.settle();
    expect(rowOf(deploymentId)).toMatchObject({ status: "cancelled", error: null, moveCopying: false });
    expect(placed(id)).toEqual([nodeA]);
  });

  test("while it waits for the old copy to stop: the wait ends at once and nothing is copied", async () => {
    const id = await liveApp("cache", [{ name: "data", mountPath: "/data" }]);
    // The old node still reports it running: the job waits for it to stop.
    fleet.reportRunning(nodeA, id, 1);
    const res = await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie });
    const deploymentId = res.body.deploymentId as string;
    const job = panel.runner.runDue(panel.deps);
    await until(() => specOn(id, nodeA)?.stopped === true, "the old copy to be stopped");

    const started = Date.now();
    const cancelled = await callOp(panel, deploymentOps.cancel, { serviceId: id, deploymentId }, { cookie });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    await job;
    // Not the two minutes the wait gives the old copy.
    expect(Date.now() - started).toBeLessThan(3000);
    expect(fleet.calls.filter((c) => c.method === "exportVolume" || c.method === "importVolume")).toEqual([]);
    expect(placed(id)).toEqual([nodeA]);
    expect(specOn(id, nodeA)?.stopped).toBe(false);
    expect(specOn(id, nodeB)).toBeNull();
    expect(rowOf(deploymentId)?.status).toBe("cancelled");
  });

  test("before its job starts: nothing was stopped, and the job leaves it alone", async () => {
    const id = await liveApp("cache", [{ name: "data", mountPath: "/data" }]);
    const res = await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie });
    const deploymentId = res.body.deploymentId as string;
    const cancelled = await callOp(panel, deploymentOps.cancel, { serviceId: id, deploymentId }, { cookie });
    expect(cancelled.body.status).toBe("cancelled");
    await panel.runner.runDue(panel.deps);
    expect(placed(id)).toEqual([nodeA]);
    expect(specOn(id, nodeA)?.stopped).toBe(false);
    expect(fleet.calls.filter((c) => c.method === "exportVolume")).toEqual([]);
  });

  test("once the copy is done and the new node starts it: refused, and the move goes on", async () => {
    const id = await liveApp("cache", [{ name: "data", mountPath: "/data" }]);
    fleet.volumes.set(nodeA, new Map([[`${id}/data`, bytes("tar.gz bytes of the volume")]]));
    fleet.reportRunning(nodeA, id, 1, "", ServicePhase.STOPPED);
    const res = await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie });
    const deploymentId = res.body.deploymentId as string;
    await panel.runner.runDue(panel.deps);
    await fleet.settle();
    const view = await viewOf(id, deploymentId);
    expect(view.status).toBe("deploying");
    expect(view.move).toMatchObject({ to: { id: nodeB, name: "node-b" }, copying: false, canCancel: false });

    const refused = await callOp(panel, deploymentOps.cancel, { serviceId: id, deploymentId }, { cookie });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "moveStarting" } });
    expect(refused.body.error.message).toBe(
      "The data is copied and the service is starting on node-b, so cancelling now could lose what it writes there. The move ends on its own: it runs on node-b once it is healthy, or goes back to node-a if it fails.",
    );
    expect(rowOf(deploymentId)?.status).toBe("deploying");
    expect(placed(id)).toEqual([nodeA, nodeB].sort());
    expect(specOn(id, nodeB)?.stopped).toBe(false);

    fleet.deployProgress(nodeB, id, view.generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    expect(rowOf(deploymentId)?.status).toBe("live");
    expect((await viewOf(id, deploymentId)).move).toEqual({
      from: { id: nodeA, name: "node-a" },
      to: { id: nodeB, name: "node-b" },
      copying: false,
      canCancel: false,
    });
  });
});

describe("cancelling a move without volumes", () => {
  test("taken until it ends: the new node's copy goes and the old one kept serving", async () => {
    const id = await liveApp("web");
    const res = await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie });
    const deploymentId = res.body.deploymentId as string;
    await fleet.settle();
    const view = await viewOf(id, deploymentId);
    expect(view.status).toBe("deploying");
    // It rolls out on both nodes; the new node is still the one it goes to.
    expect(view.move).toEqual({ from: { id: nodeA, name: "node-a" }, to: { id: nodeB, name: "node-b" }, copying: false, canCancel: true });

    const cancelled = await callOp(panel, deploymentOps.cancel, { serviceId: id, deploymentId }, { cookie });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    expect(placed(id)).toEqual([nodeA]);
    expect(specOn(id, nodeA)?.stopped).toBe(false);
    expect(specOn(id, nodeB)).toBeNull();
  });

  test("other deployments have no move", async () => {
    const id = await liveApp("web");
    const list = await callOp(panel, deploymentOps.list, { serviceId: id }, { cookie });
    expect(list.body.deployments.map((d: { move: unknown }) => d.move)).toEqual([null]);
  });
});
