// What runs now, next to what a deploy does (0.2.17): status says
// "building" for a deploy that is queued or builds (waiting for a build slot
// included) and "deploying" while it rolls out, before looking at what runs;
// runtimeStatus is what runs meanwhile, so the screens' status dot stays
// green for a live version that serves through a deploy. Every list and
// page that shows services has it: services.list, services.get (and its
// compose members), compose.get.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { compose, deployments as deploymentOps, projects, services as serviceOps } from "@seylo/ops";
import { DeployStage, HealthState, InstanceState, ServicePhase, ServiceStatusSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import type { AgentHub } from "../src/agent-hub/hub";
import { deployments } from "../src/db/schema";
import { runtimePhaseStatus, runtimeStatus, type StatusInput, serviceStatus } from "../src/modules/services/status";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

type Report = MessageInitShape<typeof ServiceStatusSchema>;

/** The agents' view: one report per node, and which nodes are online. */
function agentsWith(reports: Record<string, Report>, online: readonly string[] = Object.keys(reports)): AgentHub {
  const statuses = Object.entries(reports).map(([nodeId, report]) => ({ nodeId, status: create(ServiceStatusSchema, report) }));
  return {
    isOnline: (nodeId: string) => online.includes(nodeId),
    state: { serviceStatuses: () => statuses },
  } as unknown as AgentHub;
}

const healthy = { containerId: "c1", generation: 1n, state: InstanceState.RUNNING, health: HealthState.HEALTHY };
const running: Report = { serviceId: "s1", phase: ServicePhase.RUNNING, instances: [healthy] };
const crashLooping: Report = { serviceId: "s1", phase: ServicePhase.CRASH_LOOPING, instances: [] };
/** The agent rolls a new version out while the old one still serves. */
const rollingOut: Report = {
  serviceId: "s1",
  phase: ServicePhase.DEPLOYING,
  instances: [healthy, { containerId: "c2", generation: 2n, state: InstanceState.RUNNING, health: HealthState.STARTING }],
};

const base: Omit<StatusInput, "activeDeploy"> = { serviceId: "s1", kind: "app", stopped: false, deployed: true, nodeIds: ["n1"] };

describe("runtimeStatus next to status", () => {
  const live = {
    running: { input: base, agents: agentsWith({ n1: running }), runs: "running" },
    crashed: { input: base, agents: agentsWith({ n1: crashLooping }), runs: "crashed" },
    stopped: {
      input: { ...base, stopped: true },
      agents: agentsWith({ n1: { ...running, phase: ServicePhase.STOPPED, instances: [] } }),
      runs: "stopped",
    },
    // Never deployed: the first deploy has not reached a node (no target deployment yet).
    none: { input: { ...base, deployed: false }, agents: agentsWith({}), runs: "idle" },
  } as const;
  const says = { queued: "building", building: "building", deploying: "deploying" } as const;

  for (const activeDeploy of ["queued", "building", "deploying"] as const) {
    for (const [version, { input, agents, runs }] of Object.entries(live)) {
      test(`a deploy ${activeDeploy}, live version ${version}: status ${says[activeDeploy]}, runtimeStatus ${runs}`, () => {
        expect(serviceStatus(agents, { ...input, activeDeploy })).toBe(says[activeDeploy]);
        expect(runtimeStatus(agents, input)).toBe(runs);
      });
    }
  }

  test("without a deploy they are the same", () => {
    for (const { input, agents, runs } of Object.values(live)) {
      expect(serviceStatus(agents, { ...input, activeDeploy: null })).toBe(runs);
      expect(runtimeStatus(agents, input)).toBe(runs);
    }
  });

  test("a first deploy that rolls out: what its node reports, starting until then", () => {
    expect(runtimeStatus(agentsWith({ n1: { serviceId: "s1", phase: ServicePhase.PULLING } }), base)).toBe("starting");
    expect(runtimeStatus(agentsWith({}, ["n1"]), base)).toBe("starting");
  });

  test("a node that rolls a new version out next to the live one: what the live one does", () => {
    const agents = agentsWith({ n1: rollingOut });
    expect(runtimeStatus(agents, base)).toBe("running");
    // status keeps saying deploying, also for an agent's rollout without a deployment row.
    expect(serviceStatus(agents, { ...base, activeDeploy: null })).toBe("deploying");
    expect(serviceStatus(agents, { ...base, activeDeploy: "deploying" })).toBe("deploying");

    const failing = { ...healthy, health: HealthState.UNHEALTHY };
    expect(runtimePhaseStatus(create(ServiceStatusSchema, { ...rollingOut, instances: [failing] }))).toBe("unhealthy");
    // Recreate mode stopped the old version first: nothing runs, so it is the rollout.
    const stopped = { ...healthy, state: InstanceState.EXITED };
    expect(runtimePhaseStatus(create(ServiceStatusSchema, { ...rollingOut, instances: [stopped] }))).toBe("deploying");
  });

  test("a node that went offline is unknown, and several nodes combine as status does", () => {
    expect(runtimeStatus(agentsWith({ n1: running }, []), base)).toBe("unknown");
    const two = { ...base, nodeIds: ["n1", "n2"] };
    expect(runtimeStatus(agentsWith({ n1: running, n2: crashLooping }), two)).toBe("partial");
    expect(runtimeStatus(agentsWith({ n1: rollingOut, n2: running }), two)).toBe("running");
  });

  test("a compose stack runs through its members", () => {
    expect(runtimeStatus(agentsWith({ n1: running }), { ...base, kind: "compose" })).toBe("idle");
  });
});

describe("the ops", () => {
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
    projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
  });
  afterEach(() => panel.close());

  async function deploy(serviceId: string) {
    const res = await callOp(panel, deploymentOps.deploy, { serviceId }, { cookie });
    expect(res.status).toBe(200);
    await fleet.settle();
    return panel.deps.db.select().from(deployments).where(eq(deployments.id, res.body.id)).get()?.generation as number;
  }

  async function goLive(serviceId: string, generation: number) {
    fleet.deployProgress(nodeA, serviceId, generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    fleet.reportRunning(nodeA, serviceId, generation);
  }

  const get = async (serviceId: string) => (await callOp(panel, serviceOps.get, { serviceId }, { cookie })).body;
  const listed = async (serviceId: string) =>
    ((await callOp(panel, serviceOps.list, { projectId }, { cookie })).body.services as { id: string }[]).find((s) => s.id === serviceId);

  test("services.get and services.list: a live app that deploys again still runs", async () => {
    const res = await callOp(
      panel,
      serviceOps.create,
      {
        projectId,
        name: "api",
        kind: "app",
        nodeId: nodeA,
        source: { type: "image", image: "ghcr.io/acme/api:1", registryId: null },
        ports: [{ containerPort: 3000, protocol: "tcp" }],
      },
      { cookie },
    );
    expect(res.status).toBe(200);
    const id = res.body.id as string;
    expect(await get(id)).toMatchObject({ status: "idle", runtimeStatus: "idle", liveDeployment: null });

    // The first deploy rolls out: nothing live, and the node has not reported yet.
    const first = await deploy(id);
    expect(await get(id)).toMatchObject({ status: "deploying", runtimeStatus: "starting", liveDeployment: null });
    await goLive(id, first);
    expect(await get(id)).toMatchObject({ status: "running", runtimeStatus: "running" });

    // A second deploy rolls out next to the live version, which serves meanwhile.
    const second = await deploy(id);
    fleet.reportRunning(nodeA, id, first, "", ServicePhase.DEPLOYING);
    for (const service of [await get(id), await listed(id)]) {
      expect(service).toMatchObject({ status: "deploying", runtimeStatus: "running", liveDeployment: { id: expect.any(String) } });
    }

    // The live version crashes while the deploy goes on: the dot turns red, the status still says deploying.
    fleet.reportRunning(nodeA, id, first, "", ServicePhase.CRASH_LOOPING);
    expect(await listed(id)).toMatchObject({ status: "deploying", runtimeStatus: "crashed" });

    await goLive(id, second);
    expect(await listed(id)).toMatchObject({ status: "running", runtimeStatus: "running" });
  });

  test("a stack's members carry it in services.get, compose.get and services.list", async () => {
    fleet.answers.set("parseCompose", () => ({
      projectJson: new TextEncoder().encode(JSON.stringify({ name: "stack", services: { web: { image: "nginx:1.27" } } })),
      warnings: [],
    }));
    const created = await callOp(
      panel,
      compose.create,
      { projectId, name: "stack", nodeId: nodeA, source: { type: "inline", yaml: "services: {}\n" } },
      { cookie },
    );
    expect(created.status).toBe(200);
    await fleet.settle();
    const stackId = created.body.stack.id as string;
    const webId = (created.body.members as { id: string }[])[0]?.id as string;
    const first = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, webId)).get()?.generation as number;
    await goLive(webId, first);

    await deploy(webId);
    fleet.reportRunning(nodeA, webId, first, "", ServicePhase.DEPLOYING);
    const member = {
      id: webId,
      status: "deploying",
      runtimeStatus: "running",
      liveDeployment: expect.objectContaining({ id: expect.any(String) }),
    };
    expect((await get(stackId)).members).toEqual([expect.objectContaining(member)]);
    const stack = (await callOp(panel, compose.get, { serviceId: stackId }, { cookie })).body;
    expect(stack.members).toEqual([expect.objectContaining(member)]);
    expect(stack.stack.members).toEqual([expect.objectContaining(member)]);
    expect(await listed(webId)).toMatchObject(member);
  });
});
