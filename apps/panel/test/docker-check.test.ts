// The Docker version check (node.docker-check.v1): agents report what they
// found in NodeFacts.docker_update, the panel keeps the newest report per
// node (also from nodes.updateDocker and its UpdateResult) and shows it as
// the node's docker. Older agents report nothing and their nodes have none.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { nodes as nodeOps } from "@seylo/ops";
import { type DockerUpdateInfoSchema, ReportEventRequestSchema, ReportEventResponseSchema, UpdateTarget } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { nodes } from "../src/db/schema";
import { dockerCheckCapability, dockerCheckStaleMs, dockerView } from "../src/modules/nodes/docker-check";
import { allCapabilities, type FakeAgent } from "./fake-agent";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";

let panel: TestPanel;
let url: string;
let owner: Awaited<ReturnType<typeof createUser>>;
const agents: FakeAgent[] = [];

beforeEach(async () => {
  panel = testPanel();
  url = listen(panel);
  owner = await createUser(panel, "owner");
});
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

const ok = async <T>(promise: Promise<{ status: number; body: T }>) => {
  const res = await promise;
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

const hour = 3600_000;
const checking = [...allCapabilities, dockerCheckCapability];

/** NodeFacts.docker_update as an agent sends it. */
const report = (
  installed: string,
  candidate: string,
  at: Date,
  extra: Partial<MessageInitShape<typeof DockerUpdateInfoSchema>> = {},
): MessageInitShape<typeof DockerUpdateInfoSchema> => ({
  installed,
  candidate,
  packageManager: "apt",
  checkedAt: timestampFromDate(at),
  updatable: true,
  reason: "",
  ...extra,
});

async function join(capabilities: string[], facts: Record<string, unknown>) {
  const agent = await joinAgent(panel, url, { capabilities, facts: { dockerVersion: "29.9.3", ...facts } });
  agents.push(agent);
  return agent;
}

const getNode = (nodeId: string) => ok(callOp(panel, nodeOps.get, { nodeId }, { cookie: owner.cookie }));

/** Waits until the node's docker matches (facts are written at most every 2 s per node). */
async function waitForDocker(nodeId: string, expected: Record<string, unknown>) {
  let last: unknown;
  for (let i = 0; i < 80; i++) {
    const node = await getNode(nodeId);
    last = node.docker;
    if (node.docker && Object.entries(expected).every(([key, value]) => (node.docker as Record<string, unknown>)[key] === value)) {
      return node.docker;
    }
    await Bun.sleep(50);
  }
  throw new Error(`docker never became ${JSON.stringify(expected)}: ${JSON.stringify(last)}`);
}

test("an agent's report shows as the node's docker and stays while the node is offline", async () => {
  const checkedAt = new Date(Date.now() - 2 * hour);
  const agent = await join(checking, { dockerUpdate: report("29.9.3", "29.9.4", checkedAt) });
  const docker = await waitForDocker(agent.nodeId, { updateAvailable: true });
  expect(docker).toEqual({ version: "29.9.3", latest: "29.9.4", updateAvailable: true, checkedAt: checkedAt.toISOString(), reason: null });
  expect(panel.deps.db.select().from(nodes).where(eq(nodes.id, agent.nodeId)).get()?.dockerUpdate).toMatchObject({
    installed: "29.9.3",
    candidate: "29.9.4",
    packageManager: "apt",
    updatable: true,
  });
  const listed = await ok(callOp(panel, nodeOps.list, {}, { cookie: owner.cookie }));
  expect(listed.nodes.find((n: { id: string }) => n.id === agent.nodeId)?.docker?.latest).toBe("29.9.4");

  await agent.close();
  for (let i = 0; i < 100 && panel.deps.agents.isOnline(agent.nodeId); i++) await Bun.sleep(5);
  expect((await getNode(agent.nodeId)).docker).toMatchObject({ latest: "29.9.4", updateAvailable: true });
});

test("a newer check replaces the report; an older one does not", async () => {
  const agent = await join(checking, { dockerUpdate: report("29.9.3", "29.9.4", new Date(Date.now() - 3 * hour)) });
  await waitForDocker(agent.nodeId, { updateAvailable: true });
  // The next day's check: Docker was updated by hand, nothing newer.
  const facts = (dockerUpdate: MessageInitShape<typeof DockerUpdateInfoSchema>) => ({
    hostname: "fake-host",
    dockerVersion: "29.9.4",
    capabilities: checking,
    dockerUpdate,
  });
  agent.event({ payload: { case: "nodeFacts", value: facts(report("29.9.4", "29.9.4", new Date(Date.now() - hour))) } });
  await waitForDocker(agent.nodeId, { version: "29.9.4", updateAvailable: false });
  // A report from before it (a clock behind, a late event) changes nothing.
  agent.event({ payload: { case: "nodeFacts", value: facts(report("29.9.3", "29.9.5", new Date(Date.now() - 5 * hour))) } });
  await Bun.sleep(2500);
  expect((await getNode(agent.nodeId)).docker).toMatchObject({ version: "29.9.4", latest: "29.9.4", updateAvailable: false });
});

test("the Docker version running counts: an update made by hand is no update available", async () => {
  // The check saw 29.9.3 and 29.9.4; since then Docker 29.9.4 runs.
  const agent = await join(checking, { dockerVersion: "29.9.4", dockerUpdate: report("29.9.3", "29.9.4", new Date()) });
  expect(await waitForDocker(agent.nodeId, { updateAvailable: false })).toMatchObject({ version: "29.9.4", latest: "29.9.4" });
});

test("Docker the agent cannot update shows why, and no update state", async () => {
  const reason = "Docker Engine was not installed with apt (static binaries or snap, for example), so the agent cannot update it.";
  const agent = await join(checking, { dockerUpdate: report("", "", new Date(), { updatable: false, reason }) });
  expect(await waitForDocker(agent.nodeId, { reason })).toMatchObject({ version: "29.9.3", latest: null, updateAvailable: null });
});

test("an older agent has no docker, and its dry runs record nothing", async () => {
  const agent = await join(allCapabilities, {});
  agent.handle("UpdateDocker", () => ({ fromVersion: "29.9.3", toVersion: "29.9.3", warning: "" }));
  const dry = await ok(callOp(panel, nodeOps.updateDocker, { nodeId: agent.nodeId, dryRun: true }, { cookie: owner.cookie }));
  expect(dry).toMatchObject({ fromVersion: "29.9.3", toVersion: "29.9.3" });
  const node = await getNode(agent.nodeId);
  expect("docker" in node).toBe(false);
  expect(panel.deps.db.select().from(nodes).where(eq(nodes.id, agent.nodeId)).get()?.dockerUpdate).toBeNull();
});

test("a dry run refreshes the report, and a finished upgrade records the new version", async () => {
  // Yesterday's check found nothing newer.
  const agent = await join(checking, { dockerUpdate: report("29.9.3", "29.9.3", new Date(Date.now() - 20 * hour)) });
  await waitForDocker(agent.nodeId, { updateAvailable: false });
  agent.handle("UpdateDocker", () => ({ fromVersion: "29.9.3", toVersion: "29.9.4", warning: "" }));

  // The person's dry run sees 29.9.4: the node says so at once.
  await ok(callOp(panel, nodeOps.updateDocker, { nodeId: agent.nodeId, dryRun: true }, { cookie: owner.cookie }));
  expect((await getNode(agent.nodeId)).docker).toMatchObject({ latest: "29.9.4", updateAvailable: true });
  expect(panel.deps.db.select().from(nodes).where(eq(nodes.id, agent.nodeId)).get()?.dockerUpdate?.packageManager).toBe("apt");

  // The upgrade, then its result: 29.9.4 is installed and nothing newer.
  await ok(callOp(panel, nodeOps.updateDocker, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
  const updateId = agent.requests("UpdateDocker").at(-1).updateId;
  await agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
    outboxId: 1n,
    event: {
      payload: {
        case: "updateResult",
        value: {
          target: UpdateTarget.DOCKER,
          updateId,
          success: true,
          fromVersion: "29.9.3",
          toVersion: "29.9.4",
          finishedAt: timestampFromDate(new Date()),
        },
      },
    },
  });
  expect((await getNode(agent.nodeId)).docker).toMatchObject({ latest: "29.9.4", updateAvailable: false });
});

test("a failed upgrade leaves the update available", async () => {
  const agent = await join(checking, { dockerUpdate: report("29.9.3", "29.9.4", new Date(Date.now() - hour)) });
  await waitForDocker(agent.nodeId, { updateAvailable: true });
  agent.handle("UpdateDocker", () => ({ fromVersion: "29.9.3", toVersion: "29.9.4", warning: "" }));
  await ok(callOp(panel, nodeOps.updateDocker, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
  const updateId = agent.requests("UpdateDocker").at(-1).updateId;
  await agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
    outboxId: 1n,
    event: {
      payload: {
        case: "updateResult",
        value: { target: UpdateTarget.DOCKER, updateId, success: false, error: "dpkg failed", fromVersion: "29.9.3", toVersion: "29.9.4" },
      },
    },
  });
  expect((await getNode(agent.nodeId)).docker).toMatchObject({ latest: "29.9.4", updateAvailable: true });
});

test("an agent clock behind the panel's still records the finished upgrade", async () => {
  // The agent's clock is two hours behind: its times come before the panel's dry run.
  const behind = (ms: number) => new Date(Date.now() - 2 * hour - ms);
  const agent = await join(checking, { dockerUpdate: report("29.9.3", "29.9.4", behind(hour)) });
  await waitForDocker(agent.nodeId, { updateAvailable: true });
  agent.handle("UpdateDocker", () => ({ fromVersion: "29.9.3", toVersion: "29.9.4", warning: "" }));
  await ok(callOp(panel, nodeOps.updateDocker, { nodeId: agent.nodeId, dryRun: true }, { cookie: owner.cookie }));
  await ok(callOp(panel, nodeOps.updateDocker, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
  const updateId = agent.requests("UpdateDocker").at(-1).updateId;
  await agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
    outboxId: 1n,
    event: {
      payload: {
        case: "updateResult",
        value: {
          target: UpdateTarget.DOCKER,
          updateId,
          success: true,
          fromVersion: "29.9.3",
          toVersion: "29.9.4",
          finishedAt: timestampFromDate(behind(0)),
        },
      },
    },
  });
  expect((await getNode(agent.nodeId)).docker).toMatchObject({ latest: "29.9.4", updateAvailable: false });
  // The facts it sends again on its next connect (the old finding) change nothing.
  agent.event({
    payload: {
      case: "nodeFacts",
      value: {
        hostname: "fake-host",
        dockerVersion: "29.9.3",
        capabilities: checking,
        dockerUpdate: report("29.9.3", "29.9.4", behind(hour)),
      },
    },
  });
  await Bun.sleep(2500);
  expect((await getNode(agent.nodeId)).docker).toMatchObject({ latest: "29.9.4", updateAvailable: false });
});

test("an old report no longer says up to date", () => {
  const facts = { capabilities: [dockerCheckCapability], dockerVersion: "29.9.3" } as never;
  const stored = (checkedAt: string) => ({
    installed: "29.9.3",
    candidate: "29.9.3",
    packageManager: "apt",
    checkedAt,
    updatable: true,
    reason: "",
    agentCheckedAt: checkedAt,
  });
  const now = Date.parse("2026-11-10T12:00:00Z");
  expect(dockerView(stored(new Date(now - hour).toISOString()), facts, now)?.updateAvailable).toBe(false);
  // The agent checks daily: two days without a report mean its checks fail, so Update Docker is offered again.
  expect(dockerView(stored(new Date(now - dockerCheckStaleMs - 1).toISOString()), facts, now)?.updateAvailable).toBeNull();
  // An update that was there stays there.
  const newer = { ...stored(new Date(now - 10 * dockerCheckStaleMs).toISOString()), candidate: "29.9.4" };
  expect(dockerView(newer, facts, now)?.updateAvailable).toBe(true);
  // Without the capability (an agent downgraded since) nothing shows.
  expect(dockerView(newer, { capabilities: [], dockerVersion: "29.9.3" } as never, now)).toBeUndefined();
});
