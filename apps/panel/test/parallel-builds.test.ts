// "Builds at once" on Auto (0.2.15): the panel sends the number Auto works
// out from the node's stored facts as NodeSettings.max_parallel_builds (0
// while Can build is off), follows the machine when its cores or memory
// change, starts new nodes on Auto, and nodes.updateSettings switches
// between Auto and a fixed number with the 0.2.13 call still working.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { create, toJson } from "@bufbuild/protobuf";
import { nodes as nodeOps } from "@seylo/ops";
import { NodeFactsSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { auditLog, nodes } from "../src/db/schema";
import { compileDesiredState } from "../src/desired";
import { allCapabilities, type FakeAgent } from "./fake-agent";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { addJoinToken, joinAgent, listen } from "./hub-helpers";

const gib = 1024 ** 3;
/** NodeFacts as the panel stores them in nodes.facts (protobuf JSON, memory as a string). */
const storedFacts = (cpuCores: number, memoryGiB: number) =>
  toJson(NodeFactsSchema, create(NodeFactsSchema, { hostname: "box", cpuCores, memoryTotalBytes: BigInt(memoryGiB * gib) })) as Record<
    string,
    unknown
  >;

let panel: TestPanel;
const agents: FakeAgent[] = [];

beforeEach(() => {
  panel = testPanel();
});
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  if (panel.app.server) await panel.app.stop(true);
  panel.close();
});

function addNode(values: Partial<typeof nodes.$inferInsert> = {}) {
  return panel.deps.db
    .insert(nodes)
    .values({ name: `n-${crypto.randomUUID().slice(0, 6)}`, publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))), ...values })
    .returning()
    .get();
}

const rowOf = (id: string) => panel.deps.db.select().from(nodes).where(eq(nodes.id, id)).get();
const sentBuilds = (id: string) =>
  compileDesiredState(panel.deps.db, id, {
    revision: 1n,
    secrets: panel.deps.secrets,
    contributors: panel.deps.agents.desired.contributors(),
  }).settings?.maxParallelBuilds;

describe("the desired state", () => {
  test("Auto sends the number the stored facts give; a fixed number is sent as it is; 0 without Can build", () => {
    const ra = addNode({ canBuild: true, facts: storedFacts(28, 157) });
    const tlv = addNode({ canBuild: true, facts: storedFacts(32, 121) });
    const panelNode = addNode({ canBuild: true, facts: storedFacts(4, 7.75) });
    const never = addNode({ canBuild: true });
    const fixed = addNode({ canBuild: true, parallelBuildsAuto: false, maxParallelBuilds: 3, facts: storedFacts(32, 121) });
    const off = addNode({ canBuild: false, facts: storedFacts(32, 121) });
    expect([ra, tlv, panelNode, never, fixed, off].map((n) => sentBuilds(n.id))).toEqual([7, 8, 1, 1, 3, 0]);
  });
});

describe("nodes.updateSettings", () => {
  test("each field, both, and the refusal of Auto with a number", async () => {
    const { cookie } = await createUser(panel, "owner");
    const node = addNode({ canBuild: true, parallelBuildsAuto: false, maxParallelBuilds: 3, facts: storedFacts(28, 157) });
    const update = (input: Record<string, unknown>) => callOp(panel, nodeOps.updateSettings, { nodeId: node.id, ...input }, { cookie });
    const state = () => {
      const row = rowOf(node.id);
      return { auto: row?.parallelBuildsAuto, fixed: row?.maxParallelBuilds, sent: sentBuilds(node.id) };
    };

    // Auto on: the view and the agent get Auto's 7; the fixed number stays stored.
    const auto = await update({ parallelBuildsAuto: true });
    expect(auto.status).toBe(200);
    expect(auto.body).toMatchObject({ parallelBuildsAuto: true, maxParallelBuilds: 7 });
    expect(state()).toEqual({ auto: true, fixed: 3, sent: 7 });

    // Auto off without a number keeps the one that applied: Auto's 7.
    const frozen = await update({ parallelBuildsAuto: false });
    expect(frozen.body).toMatchObject({ parallelBuildsAuto: false, maxParallelBuilds: 7 });
    expect(state()).toEqual({ auto: false, fixed: 7, sent: 7 });
    // Already fixed, it changes nothing.
    await update({ parallelBuildsAuto: false });
    expect(state()).toEqual({ auto: false, fixed: 7, sent: 7 });

    // The 0.2.13 call: a number alone is a fixed number and turns Auto off.
    await update({ parallelBuildsAuto: true });
    const old = await update({ maxParallelBuilds: 4 });
    expect(old.body).toMatchObject({ parallelBuildsAuto: false, maxParallelBuilds: 4 });
    expect(state()).toEqual({ auto: false, fixed: 4, sent: 4 });

    // Both, the fixed way.
    await update({ parallelBuildsAuto: true });
    const both = await update({ parallelBuildsAuto: false, maxParallelBuilds: 2 });
    expect(both.body).toMatchObject({ parallelBuildsAuto: false, maxParallelBuilds: 2 });
    expect(state()).toEqual({ auto: false, fixed: 2, sent: 2 });

    // Auto with a number says which to leave out, and changes nothing (the other fields neither).
    const refused = await update({ parallelBuildsAuto: true, maxParallelBuilds: 5, location: "Rack 9" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "maxParallelBuilds" } });
    expect(refused.body.error.message).toContain("either Auto or a fixed number");
    expect(state()).toEqual({ auto: false, fixed: 2, sent: 2 });
    expect(rowOf(node.id)?.location).toBeNull();

    // Every call is audited with what it asked for, the refused one too.
    const audited = panel.deps.db
      .select({ input: auditLog.input, outcome: auditLog.outcome })
      .from(auditLog)
      .where(eq(auditLog.opId, "nodes.updateSettings"))
      .all();
    expect(audited.at(-1)).toEqual({
      input: { nodeId: node.id, parallelBuildsAuto: true, maxParallelBuilds: 5, location: "Rack 9" },
      outcome: "error",
    });
    expect(audited.filter((a) => a.outcome === "ok")).toHaveLength(7);
  });

  test("Auto on and off marks the node's desired state, so the agent hears of it", async () => {
    const { cookie } = await createUser(panel, "owner");
    const node = addNode({ canBuild: true, parallelBuildsAuto: false, facts: storedFacts(32, 121) });
    panel.deps.agents.desired.takeDirty();
    await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, parallelBuildsAuto: true }, { cookie });
    expect(panel.deps.agents.desired.takeDirty()).toContainEqual({ nodeId: node.id });
    await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, parallelBuildsAuto: false }, { cookie });
    expect(panel.deps.agents.desired.takeDirty()).toContainEqual({ nodeId: node.id });
  });
});

describe("with an agent", () => {
  let url: string;
  beforeEach(() => {
    url = listen(panel);
  });

  async function join(options: Parameters<typeof joinAgent>[2]) {
    const agent = await joinAgent(panel, url, options);
    agents.push(agent);
    return agent;
  }
  const lastSent = (agent: FakeAgent) => agent.requests("SyncDesired").at(-1)?.state?.settings?.maxParallelBuilds;

  test("a node that joins starts on Auto, sized from the facts of its hello", async () => {
    const agent = await join({
      token: addJoinToken(panel, undefined, { canBuild: true }),
      facts: { hostname: "il-ra", cpuCores: 28, memoryTotalBytes: 157n * BigInt(gib) },
    });
    expect(rowOf(agent.nodeId)).toMatchObject({ parallelBuildsAuto: true, canBuild: true });
    // The connect sync already carries it: the facts were stored before it compiled.
    expect(agent.requests("SyncDesired")[0]?.state?.settings?.maxParallelBuilds).toBe(7);
    const { cookie } = await createUser(panel, "owner");
    const view = await callOp(panel, nodeOps.get, { nodeId: agent.nodeId }, { cookie });
    expect(view.body).toMatchObject({ parallelBuildsAuto: true, maxParallelBuilds: 7 });
  });

  test("other cores or memory: the agent gets the new number, at reconnect and from a facts event", async () => {
    const agent = await join({
      token: addJoinToken(panel, undefined, { canBuild: true }),
      facts: { hostname: "box", cpuCores: 4, memoryTotalBytes: 8n * BigInt(gib) },
    });
    expect(lastSent(agent)).toBe(1);

    // The agent reports more hardware while connected (NodeFacts event): stored, then resent.
    const before = agent.requests("SyncDesired").length;
    agent.event({
      payload: {
        case: "nodeFacts",
        value: { hostname: "box", arch: "amd64", cpuCores: 28, memoryTotalBytes: 157n * BigInt(gib), capabilities: allCapabilities },
      },
    });
    await agent.waitFor("SyncDesired", before + 1, 6000);
    expect(lastSent(agent)).toBe(7);
    expect(rowOf(agent.nodeId)?.facts).toMatchObject({ cpuCores: 28 });

    // A facts event that leaves cores and memory alone resends nothing.
    await panel.deps.agents.desired.settled();
    const steady = agent.requests("SyncDesired").length;
    agent.event({
      payload: {
        case: "nodeFacts",
        value: {
          hostname: "box-2",
          arch: "amd64",
          cpuCores: 28,
          memoryTotalBytes: 157n * BigInt(gib),
          capabilities: allCapabilities,
        },
      },
    });
    await Bun.sleep(2300);
    expect(rowOf(agent.nodeId)?.facts).toMatchObject({ hostname: "box-2" });
    expect(agent.requests("SyncDesired")).toHaveLength(steady);

    // Moved to new hardware: the first state after the reconnect has the new number.
    await agent.close();
    const moved = await join({
      nodeId: agent.nodeId,
      key: agent.key,
      facts: { hostname: "box", cpuCores: 32, memoryTotalBytes: 121n * BigInt(gib) },
    });
    expect(moved.requests("SyncDesired")[0]?.state?.settings?.maxParallelBuilds).toBe(8);
  }, 20_000);

  test("a fixed number ignores the facts, and so does a node that does not build", async () => {
    const agent = await join({
      token: addJoinToken(panel, undefined, { canBuild: true }),
      facts: { hostname: "box", cpuCores: 4, memoryTotalBytes: 8n * BigInt(gib) },
    });
    panel.deps.db.update(nodes).set({ parallelBuildsAuto: false, maxParallelBuilds: 3 }).where(eq(nodes.id, agent.nodeId)).run();
    const before = agent.requests("SyncDesired").length;
    agent.event({
      payload: {
        case: "nodeFacts",
        value: { hostname: "box", arch: "amd64", cpuCores: 28, memoryTotalBytes: 157n * BigInt(gib), capabilities: allCapabilities },
      },
    });
    await Bun.sleep(2300);
    expect(rowOf(agent.nodeId)?.facts).toMatchObject({ cpuCores: 28 });
    expect(agent.requests("SyncDesired")).toHaveLength(before);
  }, 20_000);
});
