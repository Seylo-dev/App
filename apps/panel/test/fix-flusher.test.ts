// The desired-state flusher: an agent holding a newer revision than the
// panel (restored database) makes the panel jump ahead instead of every
// change being ignored, and one spec the agent refuses does not hold up the
// rest of the node.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { StatusCode } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { nodes, services } from "../src/db/schema";
import * as envGraph from "../src/modules/env/graph";
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

test("an agent that kept a newer revision makes the panel jump past it and resend", async () => {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  // The panel's database was restored: its counter is far behind what the agent applied.
  panel.deps.db.update(nodes).set({ desiredRevision: 2 }).where(eq(nodes.id, agent.nodeId)).run();
  const kept = 50n;
  agent.appliedRevision = kept;
  agent.handle("SyncDesired", (request: any) => {
    const revision = request.state?.revision ?? 0n;
    if (revision < kept) return { acceptedRevision: kept };
    agent.appliedRevision = revision;
    return { acceptedRevision: revision };
  });
  panel.deps.agents.desired.markDirty({ nodeId: agent.nodeId });
  await flusherFor(panel.deps)?.flush();
  await panel.deps.agents.desired.settled();
  await flusherFor(panel.deps)?.flush();
  expect(agent.appliedRevision).toBeGreaterThan(kept);
});

test("a spec the agent refuses does not stop the node's other services", async () => {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  const project = seedProject(panel);
  const bad = seedService(panel, project.id, agent.nodeId, { name: "bad" });
  const good = seedService(panel, project.id, agent.nodeId, { name: "good" });
  agent.handle("ApplyService", (request: any) => {
    if (request.service?.id === bad.id) throw new FakeStatus(StatusCode.INVALID_ARGUMENT, "volume name db.data is not valid");
    agent.desired.set(request.service.id, request.service);
    agent.appliedRevision = request.revision;
    return { acceptedRevision: request.revision };
  });
  panel.deps.agents.desired.markDirty({ projectId: project.id });
  await panel.deps.agents.desired.settled();
  expect(agent.desired.has(good.id)).toBe(true);
  expect(agent.desired.has(bad.id)).toBe(false);

  // The full sync is refused as a whole too: the panel falls back to one service at a time.
  agent.handle("SyncDesired", () => {
    throw new FakeStatus(StatusCode.INVALID_ARGUMENT, "volume name db.data is not valid");
  });
  agent.desired.clear();
  panel.deps.agents.desired.markDirty({ nodeId: agent.nodeId });
  await panel.deps.agents.desired.settled();
  expect(agent.desired.has(good.id)).toBe(true);
});

test("ApplyService passes compile their specs together: one env graph per project, not one per service", async () => {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  agent.handle("ApplyService", (request: any) => {
    agent.desired.set(request.service.id, request.service);
    return { acceptedRevision: request.revision };
  });
  const project = seedProject(panel);
  // Parked clones (stopped, never deployed) have no sealed env and resolve theirs from the graph.
  const clones = [1, 2, 3, 4, 5, 6].map((i) => seedService(panel, project.id, agent.nodeId, { name: `clone-${i}`, image: null }));
  for (const clone of clones) panel.deps.db.update(services).set({ stopped: true }).where(eq(services.id, clone.id)).run();
  await panel.deps.agents.desired.settled();

  const graphs = spyOn(envGraph, "buildEnvGraph");
  try {
    panel.deps.agents.desired.markDirty({ projectId: project.id });
    await panel.deps.agents.desired.settled();
    for (const clone of clones) expect((agent.desired.get(clone.id) as { stopped?: boolean } | undefined)?.stopped).toBe(true);
    expect(graphs.mock.calls.filter((call) => call[1] === project.id)).toHaveLength(1);
  } finally {
    graphs.mockRestore();
  }
});

test("a held node gets nothing until the hold is released, then a full sync (a panel move holds its target)", async () => {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  await panel.deps.agents.desired.settled();
  await flusherFor(panel.deps)?.flush();
  let syncs = 0;
  let applies = 0;
  agent.handle("SyncDesired", (request: any) => {
    syncs++;
    return { acceptedRevision: request.state?.revision ?? 0n };
  });
  agent.handle("ApplyService", (request: any) => {
    applies++;
    return { acceptedRevision: request.revision };
  });
  const release = panel.deps.agents.desired.hold(agent.nodeId);
  const project = seedProject(panel);
  seedService(panel, project.id, agent.nodeId, { name: "web" });
  panel.deps.agents.desired.markDirty({ projectId: project.id });
  panel.deps.agents.desired.markDirty({ nodeId: agent.nodeId });
  await panel.deps.agents.desired.settled();
  await flusherFor(panel.deps)?.flush();
  expect(syncs + applies).toBe(0);
  release();
  release(); // twice is harmless
  await panel.deps.agents.desired.settled();
  await flusherFor(panel.deps)?.flush();
  expect(syncs).toBeGreaterThanOrEqual(1);
  expect(panel.deps.agents.desired.isHeld(agent.nodeId)).toBe(false);
});
