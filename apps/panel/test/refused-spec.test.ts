// Refused specs: a spec the agent refuses fails the deployment that shipped it
// at once, with the agent's reason and one deploy_failed alert, instead of
// the rollout waiting for the health timeout. Both refusal shapes count: an
// ApplyService INVALID_ARGUMENT (and older agents' whole-state refusal), and
// SyncDesiredResponse.refused from agents that take the rest of the state.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { StatusCode } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { alerts, deployments, services } from "../src/db/schema";
import { engineFor } from "../src/modules/deployments/engine";
import { flusherFor } from "../src/modules/nodes/index";
import { type FakeAgent, FakeStatus } from "./fake-agent";
import { type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen, seedProject, seedService } from "./hub-helpers";

let panel: TestPanel;
let url: string;
const agents: FakeAgent[] = [];

beforeEach(() => {
  panel = testPanel();
  url = listen(panel);
});
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

const reason = "volume name db.data is not valid";

/** A rollout of generation 2 in flight on the node, the way deployments/engine.ts rollout() leaves it. */
function deploying(serviceId: string, nodeId: string) {
  const d = panel.deps.db
    .insert(deployments)
    .values({
      serviceId,
      generation: 2,
      trigger: "manual",
      status: "deploying",
      imageRef: "docker.io/library/nginx:1.28",
      imageDigest: "sha256:def",
      targetNodeIds: [nodeId],
      nodeResults: { [nodeId]: { status: "pending", message: "", digest: null } },
      phaseStartedAt: new Date(),
    })
    .returning()
    .get();
  panel.deps.db.update(services).set({ targetDeploymentId: d.id, generation: 2 }).where(eq(services.id, serviceId)).run();
  return d;
}

async function settle() {
  await flusherFor(panel.deps)?.flush();
  await panel.deps.agents.desired.settled();
  await engineFor(panel.deps).idle();
}

function deploymentRow(id: string) {
  return panel.deps.db.select().from(deployments).where(eq(deployments.id, id)).get();
}

function deployAlerts(serviceId: string) {
  return panel.deps.db
    .select()
    .from(alerts)
    .where(and(eq(alerts.serviceId, serviceId), eq(alerts.event, "deploy_failed")))
    .all();
}

test("an ApplyService the agent refuses fails the deploy with the agent's reason, and the old version stays the target", async () => {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  const project = seedProject(panel);
  const bad = seedService(panel, project.id, agent.nodeId, { name: "bad" });
  const live = panel.deps.db.select().from(services).where(eq(services.id, bad.id)).get()?.liveDeploymentId;
  agent.handle("ApplyService", (request: any) => {
    if (request.service?.id === bad.id && request.service.generation === 2n) throw new FakeStatus(StatusCode.INVALID_ARGUMENT, reason);
    agent.desired.set(request.service.id, request.service);
    return { acceptedRevision: request.revision };
  });
  const d = deploying(bad.id, agent.nodeId);
  panel.deps.agents.desired.markDirty({ serviceId: bad.id });
  await settle();

  const row = deploymentRow(d.id);
  expect(row?.status).toBe("failed");
  expect(row?.error).toContain(`The node refused the new settings: ${reason}.`);
  expect(row?.error).toContain("The previous version stayed live.");
  // The service runs its live deployment again.
  expect(panel.deps.db.select().from(services).where(eq(services.id, bad.id)).get()?.targetDeploymentId).toBe(live ?? null);
  const raised = deployAlerts(bad.id);
  expect(raised).toHaveLength(1);
  expect(raised[0]).toMatchObject({ nodeId: agent.nodeId, title: "Deploy of bad failed" });
  expect(raised[0]?.message).toContain(reason);

  // Refusing the same spec again (a resync) changes nothing and alerts no more.
  panel.deps.agents.desired.markDirty({ nodeId: agent.nodeId });
  await settle();
  expect(deployAlerts(bad.id)).toHaveLength(1);
});

test("SyncDesiredResponse.refused fails only the refused service's deploy; the rest of the state is taken", async () => {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  const project = seedProject(panel);
  const bad = seedService(panel, project.id, agent.nodeId, { name: "bad" });
  const good = seedService(panel, project.id, agent.nodeId, { name: "good" });
  const badDeploy = deploying(bad.id, agent.nodeId);
  const goodDeploy = deploying(good.id, agent.nodeId);
  agent.handle("SyncDesired", (request: any) => ({
    acceptedRevision: request.state.revision,
    refused: [{ serviceId: bad.id, generation: 2n, message: reason }],
  }));
  panel.deps.agents.desired.markDirty({ nodeId: agent.nodeId });
  await settle();

  expect(deploymentRow(badDeploy.id)?.status).toBe("failed");
  expect(deploymentRow(badDeploy.id)?.error).toContain(reason);
  expect(deploymentRow(goodDeploy.id)?.status).toBe("deploying");
  expect(deployAlerts(good.id)).toHaveLength(0);
  expect(deployAlerts(bad.id)).toHaveLength(1);
});

test("a refusal for another generation or a finished deploy is ignored", async () => {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  const project = seedProject(panel);
  const svc = seedService(panel, project.id, agent.nodeId, { name: "svc" });
  const d = deploying(svc.id, agent.nodeId);
  panel.deps.agents.desired.reportRefused(agent.nodeId, { serviceId: svc.id, generation: 1n, message: reason });
  panel.deps.agents.desired.reportRefused("someothernode000", { serviceId: svc.id, generation: 2n, message: reason });
  await engineFor(panel.deps).idle();
  expect(deploymentRow(d.id)?.status).toBe("deploying");
  expect(deployAlerts(svc.id)).toHaveLength(0);
});
