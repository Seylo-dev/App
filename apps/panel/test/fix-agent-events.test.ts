// What one node can make the panel do with stream-0 EVENT frames and
// GetDesiredState calls: events pass a token bucket per connection (the
// rest are dropped before decoding), best-effort events reuse a cached
// service scope, metrics keep one entry per service and a bounded number
// of live points, and facts are capped and written at most every 2 s.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { servicesOnNode } from "../src/agent-hub/service-scope";
import { agentLimits } from "../src/agent-hub/session";
import { nodes } from "../src/db/schema";
import { maxLivePoints, metricsFor } from "../src/modules/metrics/ingest";
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

async function join() {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  return agent;
}

const now = () => ({ seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 });

test("an EVENT flood is cut at the per-connection bucket; the rest is dropped before it costs anything", async () => {
  const agent = await join();
  let seen = 0;
  panel.deps.agents.onEvent("stateDelta", () => seen++);
  const started = performance.now();
  for (let i = 0; i < 20_000; i++) {
    agent.event({ payload: { case: "stateDelta", value: { epoch: 1n, seq: BigInt(i), change: { case: "serviceRemoved", value: "x" } } } });
  }
  const healthStarted = performance.now();
  const health = await fetch(`${url}/api/health`);
  const healthMs = performance.now() - healthStarted;
  await Bun.sleep(300);
  const seconds = (performance.now() - started) / 1000;
  expect(health.status).toBe(200);
  // Before: all 20,000 were decoded and fanned out (about 0.03 ms each) and the health check waited ~535 ms.
  expect(seen).toBeLessThanOrEqual(agentLimits.eventBurst + Math.ceil(seconds * agentLimits.eventsPerSecond) + 1);
  expect(seen).toBeGreaterThan(0);
  expect(healthMs).toBeLessThan(400);
});

test("best-effort events reuse the node's service scope instead of two queries each", async () => {
  const agent = await join();
  const service = seedService(panel, seedProject(panel).id, agent.nodeId);
  let lookups = 0;
  panel.deps.agents.setServiceScope((nodeId) => {
    lookups++;
    return servicesOnNode(panel.deps.db, nodeId);
  });
  let seen = 0;
  panel.deps.agents.onEvent("healthChanged", () => seen++);
  for (let i = 0; i < 500; i++) agent.event({ payload: { case: "healthChanged", value: { serviceId: service.id, current: 1 } } });
  // A service the node does not run: dropped, and looked up again at most every 100 ms.
  for (let i = 0; i < 500; i++) agent.event({ payload: { case: "healthChanged", value: { serviceId: "svc-elsewhere", current: 1 } } });
  await Bun.sleep(300);
  expect(seen).toBe(500);
  // Before: 1,000 lookups.
  expect(lookups).toBeLessThan(10);
});

test("a metrics event repeating the node's own service keeps one point; a series keeps at most maxLivePoints", async () => {
  const agent = await join();
  const service = seedService(panel, seedProject(panel).id, agent.nodeId);
  let seen = 0;
  panel.deps.agents.onEvent("metrics", () => seen++);
  agent.event({
    time: now(),
    payload: {
      case: "metrics",
      value: { node: { cpuPercent: 1 }, services: Array.from({ length: 20_000 }, () => ({ serviceId: service.id, cpuPercent: 1 })) },
    },
  });
  while (seen < 1) await Bun.sleep(5);
  const ingest = metricsFor(panel.deps) as unknown as { serviceLive: Map<string, Map<string, unknown[]>> };
  // Before: 20,000 points from one event.
  expect(ingest.serviceLive.get(service.id)?.get(agent.nodeId)).toHaveLength(1);
  for (let i = 0; i < maxLivePoints + 200; i++) {
    agent.event({ time: now(), payload: { case: "metrics", value: { services: [{ serviceId: service.id, cpuPercent: 1 }] } } });
  }
  while (seen < maxLivePoints + 201) await Bun.sleep(5);
  expect(ingest.serviceLive.get(service.id)?.get(agent.nodeId)).toHaveLength(maxLivePoints);
});

test("node facts are capped and written at most once every 2 s, the newest last", async () => {
  const agent = await join();
  let seen = 0;
  panel.deps.agents.onEvent("nodeFacts", () => seen++);
  const hostname = "h".repeat(2 << 20);
  for (let i = 0; i < 30; i++) {
    agent.event({ payload: { case: "nodeFacts", value: { hostname: `${i}${hostname}`, capabilities: ["state.sync.v1"] } } });
  }
  while (seen < 30) await Bun.sleep(5);
  expect(panel.deps.agents.state.get(agent.nodeId)?.facts?.hostname).toHaveLength(256);
  const stored = () =>
    panel.deps.db
      .select({ bytes: sql<number>`length(${nodes.facts})`, facts: nodes.facts })
      .from(nodes)
      .where(eq(nodes.id, agent.nodeId))
      .get();
  // Before: 30 UPDATEs of 2 MiB each.
  expect(stored()?.bytes).toBeLessThan(4096);
  await Bun.sleep(2100);
  expect((stored()?.facts as { hostname?: string }).hostname).toStartWith("29h");
});

test("a node's hello facts are capped before they are stored", async () => {
  const agent = await joinAgent(panel, url, { facts: { hostname: "x".repeat(100_000), capabilities: ["state.sync.v1"] } });
  agents.push(agent);
  const row = panel.deps.db.select({ facts: nodes.facts }).from(nodes).where(eq(nodes.id, agent.nodeId)).get();
  expect((row?.facts as { hostname: string }).hostname).toHaveLength(256);
});
