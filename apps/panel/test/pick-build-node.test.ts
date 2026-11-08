// pickBuildNode and docker buildx (added in 0.2.1): new nodes build by
// default, and nodes with distro Docker often have no buildx plugin. The
// agent reports it in NodeFacts.buildx; automatic picks skip a node that
// reports it missing, an explicit build node without it is refused, and
// agents that report nothing (before 0.2.1) count as able to build.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { builds, OpError } from "@seylo/ops";
import { pickBuildNode } from "../src/modules/deployments/source";
import { canBuildWarning } from "../src/modules/nodes/view";
import { defaultSpec } from "../src/modules/services/spec";
import { allCapabilities, type FakeAgent } from "./fake-agent";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { addJoinToken, joinAgent, listen } from "./hub-helpers";
import { seedProject, seedService } from "./seed-helpers";

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

type Buildx = { installed: boolean; version: string };

/** Joins a fake agent with Can build on; buildx left out is an agent from before 0.2.1. */
async function builder(name: string, buildx?: Buildx): Promise<FakeAgent> {
  const agent = await joinAgent(panel, url, {
    token: addJoinToken(panel, undefined, { canBuild: true }),
    name,
    facts: { hostname: name, ...(buildx ? { buildx } : {}) },
  });
  agents.push(agent);
  return agent;
}

function spec(buildNodeId: string | null = null) {
  const s = defaultSpec();
  s.build.buildNodeId = buildNodeId;
  return s;
}

function refusal(fn: () => unknown): OpError {
  try {
    fn();
  } catch (err) {
    if (err instanceof OpError) return err;
    throw err;
  }
  throw new Error("expected an OpError");
}

const missing = { installed: false, version: "" };
const installed = { installed: true, version: "v0.29.1" };

test("the service's own node without buildx is skipped for the least busy builder", async () => {
  const own = await builder("own", missing);
  const other = await builder("other", installed);
  expect(pickBuildNode(panel.deps, spec(), [own.nodeId])).toMatchObject({ id: other.nodeId, name: "other" });
  // Its own node with buildx keeps the build where the service runs.
  expect(pickBuildNode(panel.deps, spec(), [other.nodeId]).id).toBe(other.nodeId);
});

test("absent buildx facts (an agent before 0.2.1) count as usable", async () => {
  const old = await builder("old");
  expect(panel.deps.agents.state.get(old.nodeId)?.facts?.buildx).toBeUndefined();
  expect(pickBuildNode(panel.deps, spec(), [old.nodeId]).id).toBe(old.nodeId);
  expect(pickBuildNode(panel.deps, spec(old.nodeId), []).id).toBe(old.nodeId);
  expect(canBuildWarning(panel.deps.agents.state.get(old.nodeId)?.facts ?? null)).toBeNull();
});

test("an explicit build node without buildx is a CONFLICT that says what to install", async () => {
  const chosen = await builder("de-1", missing);
  await builder("spare", installed);
  const err = refusal(() => pickBuildNode(panel.deps, spec(chosen.nodeId), []));
  expect(err.code).toBe("CONFLICT");
  expect(err.message).toBe("de-1 has no docker buildx. Install docker-buildx-plugin on it.");
});

test("with every builder lacking buildx the refusal names them, and installing it is picked up from the facts", async () => {
  const only = await builder("lonely", missing);
  const err = refusal(() => pickBuildNode(panel.deps, spec(), [only.nodeId]));
  expect(err.code).toBe("CONFLICT");
  expect(err.details).toMatchObject({ reason: "noBuilder" });
  expect(err.message).toContain("lonely has no docker buildx");
  expect(canBuildWarning(panel.deps.agents.state.get(only.nodeId)?.facts ?? null)).toBe("docker buildx is missing");

  // The agent checks again (every minute while it is missing) and sends its whole facts again.
  only.event({ payload: { case: "nodeFacts", value: { hostname: "lonely", capabilities: allCapabilities, buildx: installed } } });
  const deadline = Date.now() + 2000;
  while (panel.deps.agents.state.get(only.nodeId)?.facts?.buildx?.installed !== true && Date.now() < deadline) await Bun.sleep(10);
  expect(pickBuildNode(panel.deps, spec(), [only.nodeId]).id).toBe(only.nodeId);
  expect(canBuildWarning(panel.deps.agents.state.get(only.nodeId)?.facts ?? null)).toBeNull();
});

test("the build settings refuse a build node that reports no buildx, and take one that has it", async () => {
  const { cookie } = await createUser(panel, "owner");
  const without = await builder("de-1", missing);
  const withIt = await builder("de-2", installed);
  const service = seedService(panel, { projectId: seedProject(panel).id, name: "web", nodeIds: [withIt.nodeId] });
  const refused = await callOp(panel, builds.updateSettings, { serviceId: service.id, buildNodeId: without.nodeId }, { cookie });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toMatchObject({
    message: "de-1 has no docker buildx. Install docker-buildx-plugin on it.",
    details: { field: "buildNodeId" },
  });
  const taken = await callOp(panel, builds.updateSettings, { serviceId: service.id, buildNodeId: withIt.nodeId }, { cookie });
  expect(taken.status).toBe(200);
  expect(taken.body.buildNodeId).toBe(withIt.nodeId);
});
