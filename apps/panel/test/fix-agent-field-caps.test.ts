// What a node says about itself and its services is cut before the panel
// keeps it. Regression tests for two PoCs: a 4 MiB ClientHello.agent_version
// stored in nodes.agent_version and served by nodes.list, and a 12 MiB
// ServiceStatus.message kept in the state store for the process lifetime.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { maxAgentVersionLength, statusLimits } from "../src/agent-hub/field-caps";
import { nodes } from "../src/db/schema";
import { toNode } from "../src/modules/nodes/view";
import type { FakeAgent } from "./fake-agent";
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

async function join(options: Parameters<typeof joinAgent>[2] = {}) {
  const agent = await joinAgent(panel, url, options);
  agents.push(agent);
  return agent;
}

/** Resolves on the next state change of `kind` for the node. */
function nextChange(nodeId: string, kind: "snapshot" | "service") {
  return new Promise<void>((resolve) => {
    const off = panel.deps.agents.state.onChange((id, change) => {
      if (id !== nodeId || change.kind !== kind) return;
      off();
      resolve();
    });
  });
}

/** About 7 MiB, inside one 16 MiB frame. */
const bigStatus = (serviceId: string) => ({
  serviceId,
  generation: 1n,
  message: "m".repeat(4 << 20),
  tunnelUrl: "u".repeat(512 << 10),
  instances: Array.from({ length: 200 }, (_, i) => ({
    containerId: `c${i}`,
    containerName: "n".repeat(2048),
    imageDigest: "d".repeat(2048),
  })),
  routes: Array.from({ length: 200 }, () => ({
    routeId: "r".repeat(2048),
    message: "e".repeat(4096),
    certificateIssuer: "i".repeat(2048),
  })),
  openPorts: [{ hostPort: 1, containerPort: 2, certificateIssuer: "i".repeat(64 << 10) }],
});

function expectCapped(status: ReturnType<typeof panel.deps.agents.state.serviceStatuses>[number]["status"] | undefined) {
  expect(status).toBeDefined();
  if (!status) return;
  expect(status.message.length).toBe(statusLimits.maxString);
  expect(status.tunnelUrl.length).toBe(statusLimits.maxString);
  expect(status.instances.length).toBe(statusLimits.maxList);
  expect(status.routes.length).toBe(statusLimits.maxList);
  for (const i of status.instances) expect(Math.max(i.containerName.length, i.imageDigest.length)).toBeLessThanOrEqual(256);
  for (const r of status.routes) {
    expect(Math.max(r.routeId.length, r.certificateIssuer.length)).toBeLessThanOrEqual(256);
    expect(r.message.length).toBeLessThanOrEqual(statusLimits.maxString);
  }
  expect(status.openPorts[0]?.certificateIssuer.length).toBeLessThanOrEqual(256);
  // Small enough to keep one per placed service.
  expect(JSON.stringify(status, (_k, v) => (typeof v === "bigint" ? String(v) : v)).length).toBeLessThan(1 << 20);
}

test("a hello's agent version and name are cut before they are stored or shown", async () => {
  const huge = `1.0.0${"x".repeat(1 << 20)}`;
  const agent = await join({ agentVersion: huge, name: "n".repeat(1 << 20), facts: { hostname: "host-a" } });
  expect(agent.rejected).toBeNull();
  const row = panel.deps.db.select().from(nodes).where(eq(nodes.id, agent.nodeId)).get();
  expect(row?.agentVersion).toBe(huge.slice(0, maxAgentVersionLength));
  expect(row?.name.length).toBeLessThanOrEqual(60);
  // nodes.list falls back to the stored version when the facts carry none.
  expect(toNode(panel.deps, row as NonNullable<typeof row>).agentVersion?.length).toBe(maxAgentVersionLength);
  // A normal version is untouched.
  const normal = await join({ agentVersion: "0.2.0-rc.1-5-gabc1234-dirty" });
  expect(panel.deps.db.select().from(nodes).where(eq(nodes.id, normal.nodeId)).get()?.agentVersion).toBe("0.2.0-rc.1-5-gabc1234-dirty");
});

test("a state delta's ServiceStatus is cut before the state store keeps it", async () => {
  const agent = await join();
  const svc = seedService(panel, seedProject(panel).id, agent.nodeId);
  const changed = nextChange(agent.nodeId, "service");
  agent.event({
    payload: { case: "stateDelta", value: { epoch: 1n, seq: 1n, change: { case: "serviceUpdated", value: bigStatus(svc.id) } } },
  });
  await changed;
  expectCapped(panel.deps.agents.state.serviceStatuses(svc.id)[0]?.status);
});

test("a snapshot's ServiceStatus entries are cut before the state store keeps them", async () => {
  const agent = await join();
  const svc = seedService(panel, seedProject(panel).id, agent.nodeId);
  agent.handle("GetStateSnapshot", () => ({
    snapshot: { epoch: 2n, seq: 1n, appliedRevision: agent.appliedRevision, services: [bigStatus(svc.id)] },
  }));
  const applied = nextChange(agent.nodeId, "snapshot");
  // Another epoch: the panel fetches a snapshot.
  agent.event({ payload: { case: "stateDelta", value: { epoch: 2n, seq: 1n, change: { case: "appliedRevision", value: 0n } } } });
  await applied;
  expectCapped(panel.deps.agents.state.serviceStatuses(svc.id)[0]?.status);
});
