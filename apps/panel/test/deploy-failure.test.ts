// From the owner's CSSPanel deploys on 2026-11-13 (0.2.16):
//
//   - A failed deploy's error, its log and the alert carried the new
//     container's own output, line by line under the deploy's steps ("health"
//     and "switch" lines of "Server is running on port 6000"). The reason
//     stands alone now; the output is Deployment.lastOutput. Agents before
//     0.2.16 still send it inside the message, after "last output:".
//   - The agent says which ports the app listens on (not_listening):
//     Deployment.portHint, and services.usePort switches the service to one,
//     with its domains, IP:port access and tunnel on the old port.
//   - trust-api was moved to another node while it built and its rollout
//     waited on a node that no longer had it. A change of nodes now waits
//     for the deploy, a node that no longer holds the service fails the
//     rollout at once, and a node that says nothing fails it after the
//     health timeout and a margin.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deployments as deploymentOps, projects, services as serviceOps } from "@seylo/ops";
import { DeployStage, ServicePhase } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import {
  alerts,
  cloudflareTunnels,
  deploymentLogs,
  deployments,
  domains,
  portExposures,
  servicePlacements,
  services,
} from "../src/db/schema";
import { compileDesiredState } from "../src/desired/compile";
import { engineFor } from "../src/modules/deployments/engine";
import { legacyError, splitLastOutput } from "../src/modules/deployments/failure";
import { serviceNetworking } from "../src/modules/domains/desired";
import { deploymentEnv, sealDeploymentEnv } from "../src/modules/env/desired";
import { serviceSpecFor } from "../src/modules/services/desired";
import { readSpec, withFirstPort } from "../src/modules/services/spec";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let nodeA: string;
let nodeB: string;

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("start-app");
  nodeB = fleet.addNode("il-ra");
  fleet.addNode("builder", { canBuild: true, panelNode: true });
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "csspanel" }, { cookie })).body.id;
});
afterEach(() => panel.close());

async function createApp(name: string, port = 80) {
  const res = await callOp(
    panel,
    serviceOps.create,
    {
      projectId,
      name,
      kind: "app",
      nodeId: nodeA,
      source: { type: "image", image: "ghcr.io/acme/api:1", registryId: null },
      ports: [{ containerPort: port, protocol: "tcp" }],
    },
    { cookie },
  );
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function deploy(serviceId: string) {
  const res = await callOp(panel, deploymentOps.deploy, { serviceId }, { cookie });
  expect(res.status).toBe(200);
  await fleet.settle();
  return { id: res.body.id as string, generation: row(res.body.id)?.generation as number };
}

const row = (id: string) => panel.deps.db.select().from(deployments).where(eq(deployments.id, id)).get();
const view = async (serviceId: string, deploymentId: string) =>
  (await callOp(panel, deploymentOps.get, { serviceId, deploymentId }, { cookie })).body.deployment;
const logOf = (id: string) =>
  panel.deps.db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, id))
    .orderBy(deploymentLogs.seq)
    .all()
    .map((l) => `${l.step}: ${l.text}`);
const portsOf = (id: string) => readSpec(panel.deps.db.select().from(services).where(eq(services.id, id)).get()?.spec).ports;
const domainPorts = (id: string) =>
  panel.deps.db
    .select({ host: domains.host, port: domains.targetPort })
    .from(domains)
    .where(eq(domains.serviceId, id))
    .orderBy(domains.host)
    .all()
    .map((d) => `${d.host}:${d.port}`);

/** The target ports of the routes the node gets for the service (domains/desired.ts). */
const routesOf = (id: string) => serviceNetworking(panel.deps, id, nodeA).routing.routes?.map((r) => r.targetPort) ?? [];

/** The service's container ports the node gets, and whether each carries the first-run IP:port listener. */
function portsOnNode(id: string): [number, boolean][] {
  const state = compileDesiredState(panel.deps.db, nodeA, {
    revision: 1n,
    secrets: panel.deps.secrets,
    contributors: panel.deps.agents.desired.contributors(),
  });
  return state.services.find((x) => x.id === id)?.ports.map((p) => [p.containerPort, p.public !== undefined]) ?? [];
}
/** Where the service's IP:port access (services.create opens the first-run port) and its tunnel send traffic. */
const accessPorts = (id: string) => ({
  exposures: panel.deps.db
    .select({ kind: portExposures.kind, port: portExposures.targetPort })
    .from(portExposures)
    .where(eq(portExposures.serviceId, id))
    .all()
    .map((e) => `${e.kind}:${e.port}`),
  tunnel: panel.deps.db.select().from(cloudflareTunnels).where(eq(cloudflareTunnels.serviceId, id)).get()?.targetPort ?? null,
});
function addTunnel(serviceId: string, targetPort: number) {
  panel.deps.db.insert(cloudflareTunnels).values({ serviceId, enabled: true, mode: "quick", targetPort }).run();
}

function addDomain(serviceId: string, host: string, targetPort: number) {
  panel.deps.db.insert(domains).values({ serviceId, host, targetPort, https: "off" }).run();
}

const reason =
  "not healthy after 5m0s: health check never passed: tcp check on port 80: dial tcp 172.23.0.9:80: connect: connection refused. The app listens on port 6000, not 80. Set the service's port to 6000 (Ports in the Container section of its Advanced tab) and point its domains there, or make the app listen on port 80.";
const output = ["[Cloudflare R2] Connected", "Server is running on port 6000", "Heartbeat"];
const notListening = { port: 80, read: true, listening: [{ port: 6000 }, { port: 9229, loopbackOnly: true }] };

async function failOn(nodeId: string, serviceId: string, d: { generation: number }, message: string, extra = {}) {
  fleet.deployProgress(nodeId, serviceId, d.generation, DeployStage.HEALTH_CHECKING, "");
  fleet.deployProgress(nodeId, serviceId, d.generation, DeployStage.FAILED, message, extra);
  await fleet.settle();
}

describe("the new container's last output", () => {
  test("is its own field, not in the error, the alert or the deploy log, and the failure is logged under the step that ran", async () => {
    const id = await createApp("il-ra-api");
    const d = await deploy(id);
    await failOn(nodeA, id, d, reason, { lastOutput: output, notListening });
    const failed = row(d.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe(`start-app: ${reason} The previous version stayed live.`);
    const shown = await view(id, d.id);
    expect(shown.error).toBe(failed?.error);
    expect(shown.lastOutput).toEqual({ node: { id: nodeA, name: "start-app" }, lines: output });
    const log = logOf(d.id);
    expect(log.at(-1)).toBe(`health: start-app: ${reason} The previous version stayed live.`);
    expect(log.filter((l) => l.includes(reason))).toHaveLength(1);
    for (const line of output) expect(log.join("\n")).not.toContain(line);
    expect(log.some((l) => l.startsWith("switch:"))).toBe(false);
    const alert = panel.deps.db.select().from(alerts).where(eq(alerts.event, "deploy_failed")).get();
    expect(alert?.message).toBe(reason);
  });

  test("an agent before 0.2.16 sends it inside the message: the panel splits it off", async () => {
    const id = await createApp("old-agent");
    const d = await deploy(id);
    await failOn(nodeA, id, d, `${reason.split(". The app")[0]}\nlast output:\n${output.join("\n")}`);
    const shown = await view(id, d.id);
    expect(shown.error).toBe(
      "start-app: not healthy after 5m0s: health check never passed: tcp check on port 80: dial tcp 172.23.0.9:80: connect: connection refused. The previous version stayed live.",
    );
    expect(shown.lastOutput?.lines).toEqual(output);
    expect(shown.portHint).toBeNull();
    expect(logOf(d.id).join("\n")).not.toContain("Heartbeat");
    const alert = panel.deps.db.select().from(alerts).where(eq(alerts.event, "deploy_failed")).get();
    expect(alert?.message).not.toContain("last output");
  });

  test("a deploy that failed before 0.2.16 is split as it is read: the error alone, the output in its block", async () => {
    const id = await createApp("csspanel");
    const d = await deploy(id);
    const stored =
      "il-ra: not healthy after 5m0s: health check never passed: tcp check on port 80: dial tcp 172.23.0.9:80: connect: connection refused" +
      `\nlast output:\n${output.join("\n")} The previous version stayed live.`;
    // As 0.2.14 stored it: the whole message in the error and in the node's result, no lastOutput.
    panel.deps.db
      .update(deployments)
      .set({
        status: "failed",
        error: stored,
        nodeResults: { [nodeA]: { status: "failed", message: stored.slice("il-ra: ".length), digest: null } },
      })
      .where(eq(deployments.id, d.id))
      .run();
    const shown = await view(id, d.id);
    expect(shown.error).toBe(
      "il-ra: not healthy after 5m0s: health check never passed: tcp check on port 80: dial tcp 172.23.0.9:80: connect: connection refused. The previous version stayed live.",
    );
    expect(shown.lastOutput).toEqual({ node: { id: nodeA, name: "start-app" }, lines: output });
    const listed = (await callOp(panel, deploymentOps.list, { serviceId: id }, { cookie })).body.deployments[0];
    expect(listed.error).toBe(shown.error);
    expect(listed.lastOutput?.lines).toEqual(output);
    // The stored row stays as it was; other errors are left alone.
    expect(row(d.id)?.error).toBe(stored);
    expect(legacyError("start-app: exit code 1. The previous version stayed live.")).toBeNull();
    expect(legacyError(null)).toBeNull();
    expect(legacyError("a: boom\nlast output:\nx\ny")).toEqual({ error: "a: boom", lines: ["x", "y"] });
    expect(legacyError("a: boom.\nlast output:\nx\n The previous version stayed live.")).toEqual({
      error: "a: boom. The previous version stayed live.",
      lines: ["x"],
    });
  });

  test("a first deploy whose FAILED state comes before its FAILED event still gets the output and the port hint", async () => {
    const id = await createApp("first");
    const d = await deploy(id);
    // Nothing live: the node's state delta (phase FAILED, "deploy failed: " and the reason) wins the race.
    fleet.reportRunning(nodeA, id, d.generation, "", ServicePhase.FAILED, `deploy failed: ${reason}`);
    await fleet.settle();
    const early = row(d.id);
    expect(early?.status).toBe("failed");
    expect(early?.error).toBe(`start-app: ${reason} The previous version stayed live.`);
    expect((await view(id, d.id)).lastOutput).toBeNull();
    // The event that came second carries what the state cannot.
    fleet.deployProgress(nodeA, id, d.generation, DeployStage.FAILED, reason, { lastOutput: output, notListening });
    await fleet.settle();
    const shown = await view(id, d.id);
    expect(shown.status).toBe("failed");
    expect(shown.error).toBe(early?.error);
    expect(shown.lastOutput).toEqual({ node: { id: nodeA, name: "start-app" }, lines: output });
    expect(shown.portHint).toMatchObject({ port: 80, listening: [6000], canUsePort: true });
    // Once: a replayed event does not touch it again.
    fleet.deployProgress(nodeA, id, d.generation, DeployStage.FAILED, "other", { lastOutput: ["replayed"] });
    await fleet.settle();
    expect((await view(id, d.id)).lastOutput?.lines).toEqual(output);
    expect(logOf(d.id).join("\n")).not.toContain("Heartbeat");
  });

  test("splitLastOutput", () => {
    expect(splitLastOutput("boom")).toEqual({ reason: "boom", lines: [] });
    expect(splitLastOutput("boom\nlast output:\na\nb")).toEqual({ reason: "boom", lines: ["a", "b"] });
    // Cut by the report's field cap right after the marker.
    expect(splitLastOutput("boom\nlast output:")).toEqual({ reason: "boom", lines: [] });
  });
});

describe("Use port", () => {
  test("the hint names the ports the app listens on; a compose member gets no Use port", async () => {
    const id = await createApp("api");
    const d = await deploy(id);
    await failOn(nodeA, id, d, reason, { lastOutput: output, notListening });
    expect((await view(id, d.id)).portHint).toEqual({
      node: { id: nodeA, name: "start-app" },
      port: 80,
      listening: [6000],
      loopbackOnly: [9229],
      canUsePort: true,
    });
    // A compose member's ports come from its compose file.
    const stack = await createApp("stack");
    panel.deps.db.update(services).set({ parentId: stack }).where(eq(services.id, id)).run();
    expect((await view(id, d.id)).portHint?.canUsePort).toBe(false);
  });

  test("only on loopback: a hint without Use port", async () => {
    const id = await createApp("local");
    const d = await deploy(id);
    await failOn(nodeA, id, d, reason, { notListening: { port: 80, read: true, listening: [{ port: 6000, loopbackOnly: true }] } });
    expect((await view(id, d.id)).portHint).toMatchObject({ listening: [], loopbackOnly: [6000], canUsePort: false });
  });

  test("the checked port bound only to 127.0.0.1 and another on all addresses: no Use port for the other one", async () => {
    const id = await createApp("inspector");
    const d = await deploy(id);
    // 80 on 127.0.0.1 is the mistake; 9229 (a Node inspector) or a metrics port is no port to switch to.
    await failOn(nodeA, id, d, reason, {
      notListening: { port: 80, read: true, listening: [{ port: 80, loopbackOnly: true }, { port: 9229 }] },
    });
    expect((await view(id, d.id)).portHint).toMatchObject({ port: 80, listening: [9229], loopbackOnly: [80], canUsePort: false });
  });

  test("only the service's newest deployment offers Use port: not once another deploy started or went live", async () => {
    const id = await createApp("api");
    const d1 = await deploy(id);
    await failOn(nodeA, id, d1, reason, { notListening });
    expect((await view(id, d1.id)).portHint?.canUsePort).toBe(true);
    // The app was fixed to listen on 80 and deployed again: D1's hint is history while D2 runs and once it is live.
    const d2 = await deploy(id);
    expect(row(d2.id)?.status).toBe("deploying");
    expect((await view(id, d1.id)).portHint?.canUsePort).toBe(false);
    fleet.deployProgress(nodeA, id, d2.generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    expect(row(d2.id)?.status).toBe("live");
    const listed = (await callOp(panel, deploymentOps.list, { serviceId: id }, { cookie })).body.deployments;
    expect(listed.find((x: { id: string }) => x.id === d1.id)?.portHint).toMatchObject({ listening: [6000], canUsePort: false });
  });

  test("nothing listening, or sockets not read: no hint", async () => {
    const id = await createApp("worker");
    const d = await deploy(id);
    await failOn(nodeA, id, d, reason, { notListening: { port: 80, read: true, listening: [] } });
    expect((await view(id, d.id)).portHint).toBeNull();
    expect(row(d.id)?.nodeResults[nodeA]?.notListening).toEqual({ port: 80, read: true, listening: [] });
  });

  test("without a live version: the port and its domains switch at once and a deploy starts", async () => {
    const id = await createApp("api");
    addDomain(id, "api.example.com", 80);
    addDomain(id, "admin.example.com", 8080);
    const d = await deploy(id);
    await failOn(nodeA, id, d, reason, { notListening });
    const res = await callOp(panel, serviceOps.usePort, { serviceId: id, port: 6000, fromPort: 80 }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ports: [{ containerPort: 6000, protocol: "tcp" }], domainsMove: "now" });
    expect(res.body.domainIds).toHaveLength(1);
    expect(portsOf(id)).toEqual([{ containerPort: 6000, protocol: "tcp" }]);
    expect(domainPorts(id)).toEqual(["admin.example.com:8080", "api.example.com:6000"]);
    await fleet.settle();
    const next = row(res.body.deploymentId);
    expect(next?.status).toBe("deploying");
    expect(next?.portMove).toBeNull();
    // The new generation checks and routes port 6000.
    const spec = serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA);
    expect(spec?.ports.map((p) => p.containerPort)).toEqual([6000]);
    expect(routesOf(id).sort()).toEqual([6000, 8080]);
    expect(logOf(res.body.deploymentId).slice(0, 3)).toEqual([
      "clone: Port 80 changed to 6000 (Use port 6000).",
      "clone: api.example.com moved to port 6000.",
      "clone: Its IP:port access moved to port 6000.",
    ]);
    expect(accessPorts(id).exposures).toEqual(["first_run:6000"]);
    const audit = panel.deps.db
      .select()
      .from((await import("../src/db/schema")).auditLog)
      .all();
    expect(audit.some((a) => a.opId === serviceOps.usePort.id)).toBe(true);
  });

  test("an app without a domain: its IP:port access and its tunnel follow, so it has an address on the new port", async () => {
    const id = await createApp("no-domain");
    // services.create opened the first-run port on 80; a timed expose and a tunnel on 80, one timed expose elsewhere.
    panel.deps.db
      .insert(portExposures)
      .values([
        { serviceId: id, nodeId: nodeA, kind: "timed", listenPort: 0, targetPort: 80, expiresAt: new Date(Date.now() + 600_000) },
        { serviceId: id, nodeId: nodeA, kind: "timed", listenPort: 0, targetPort: 9090, expiresAt: new Date(Date.now() + 600_000) },
      ])
      .run();
    addTunnel(id, 80);
    const d = await deploy(id);
    expect(portsOnNode(id)).toEqual([[80, true]]);
    await failOn(nodeA, id, d, reason, { notListening });
    const res = await callOp(panel, serviceOps.usePort, { serviceId: id, port: 6000, fromPort: 80 }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ domainIds: [], domainsMove: "now" });
    await fleet.settle();
    expect(row(res.body.deploymentId)?.status).toBe("deploying");
    expect(accessPorts(id)).toEqual({ exposures: ["first_run:6000", "timed:6000", "timed:9090"], tunnel: 6000 });
    // The node's PortSpec for 6000 carries the first-run listener (domains/contributor.ts matches it by container port).
    expect(portsOnNode(id)).toEqual([[6000, true]]);
    expect(logOf(res.body.deploymentId)).toContain("clone: Its IP:port access and its Cloudflare tunnel moved to port 6000.");
  });

  test("a built app's PORT follows the port", async () => {
    const id = await createApp("api");
    const svc = panel.deps.db.select().from(services).where(eq(services.id, id)).get();
    panel.deps.db
      .update(services)
      .set({
        spec: {
          ...(svc?.spec as object),
          source: { type: "git", url: "https://git.example.com/acme/api.git", branch: "main", credentialId: null, deployOnPush: false },
        },
      })
      .where(eq(services.id, id))
      .run();
    const portEnv = () => deploymentEnv(panel.deps, sealDeploymentEnv(panel.deps, id))?.find((v) => v.name === "PORT")?.value;
    expect(portEnv()).toBe("80");
    const res = await callOp(panel, serviceOps.usePort, { serviceId: id, port: 6000, fromPort: 80 }, { cookie });
    expect(res.status).toBe(200);
    expect(portEnv()).toBe("6000");
    // withPortEnv reads the first TCP port: the one usePort sets.
    expect(withFirstPort([{ containerPort: 80, protocol: "tcp" }], 6000)).toEqual([{ containerPort: 6000, protocol: "tcp" }]);
    expect(withFirstPort([{ containerPort: 80, protocol: "tcp" }], 6000)).toEqual([{ containerPort: 6000, protocol: "tcp" }]);
    expect(
      withFirstPort(
        [
          { containerPort: 53, protocol: "udp" },
          { containerPort: 80, protocol: "tcp" },
          { containerPort: 6000, protocol: "tcp" },
        ],
        6000,
      ),
    ).toEqual([
      { containerPort: 53, protocol: "udp" },
      { containerPort: 6000, protocol: "tcp" },
    ]);
    expect(withFirstPort([], 6000)).toEqual([{ containerPort: 6000, protocol: "tcp" }]);
  });

  test("with a live version: its domains keep the old port until the new containers roll out, and come back if they fail", async () => {
    const id = await createApp("api");
    addDomain(id, "api.example.com", 80);
    addTunnel(id, 80);
    const live = await deploy(id);
    fleet.deployProgress(nodeA, id, live.generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    expect(row(live.id)?.status).toBe("live");
    // A new release listens on 6000.
    const broken = await deploy(id);
    await failOn(nodeA, id, broken, reason, { notListening });

    // Built (an inline Dockerfile here), the rollout waits for the build: the domains wait with it.
    const svc = panel.deps.db.select().from(services).where(eq(services.id, id)).get();
    const spec = svc?.spec as Record<string, unknown>;
    panel.deps.db
      .update(services)
      .set({
        spec: {
          ...spec,
          source: { type: "inline" },
          build: { ...(spec.build as object), builder: "dockerfile", inlineDockerfile: "FROM nginx:1.27\n" },
        },
      })
      .where(eq(services.id, id))
      .run();
    fleet.buildScript = () => ({ result: "held", digest: `sha256:${"b".repeat(64)}` });
    const res = await callOp(panel, serviceOps.usePort, { serviceId: id, port: 6000, fromPort: 80 }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.domainsMove).toBe("rollout");
    await fleet.settle();
    // While it builds the live version keeps its route on 80; the port setting (applied on deploy) is 6000.
    expect(row(res.body.deploymentId)?.status).toBe("building");
    expect(domainPorts(id)).toEqual(["api.example.com:80"]);
    expect(portsOf(id)).toEqual([{ containerPort: 6000, protocol: "tcp" }]);
    expect(routesOf(id)[0]).toBe(80);
    // So do its IP:port access and its tunnel, and the live version's PortSpec keeps the listener.
    expect(accessPorts(id)).toEqual({ exposures: ["first_run:80"], tunnel: 80 });
    expect(portsOnNode(id)).toEqual([[80, true]]);
    expect(row(res.body.deploymentId)?.portMove).toMatchObject({ exposureIds: [expect.any(String)], tunnel: true, applied: false });

    // The build ends: the rollout and the domain move go out together.
    const build = fleet.builds.at(-1);
    if (!build) throw new Error("no build");
    fleet.endBuild(build.request.buildId);
    await fleet.settle();
    const rolling = row(res.body.deploymentId);
    expect(rolling?.status).toBe("deploying");
    expect(rolling?.portMove).toMatchObject({ fromPort: 80, toPort: 6000, applied: true });
    expect(domainPorts(id)).toEqual(["api.example.com:6000"]);
    expect(routesOf(id)[0]).toBe(6000);
    expect(accessPorts(id)).toEqual({ exposures: ["first_run:6000"], tunnel: 6000 });
    expect(portsOnNode(id)).toEqual([[6000, true]]);
    expect(logOf(res.body.deploymentId)).toContain("ship: Its IP:port access and its Cloudflare tunnel move to port 6000 with it.");

    // It fails after all: the live version listens on 80, so the domains and the port go back there.
    await failOn(nodeA, id, { generation: rolling?.generation as number }, "not healthy after 5m0s: health check never passed");
    await fleet.settle();
    expect(row(res.body.deploymentId)?.status).toBe("failed");
    expect(domainPorts(id)).toEqual(["api.example.com:80"]);
    expect(portsOf(id)).toEqual([{ containerPort: 80, protocol: "tcp" }]);
    expect(logOf(res.body.deploymentId).at(-1)).toBe(
      "health: The service's port, its domains, its IP:port access and its Cloudflare tunnel are back on 80, where the live version listens.",
    );
    expect(routesOf(id)[0]).toBe(80);
    expect(accessPorts(id)).toEqual({ exposures: ["first_run:80"], tunnel: 80 });
    expect(portsOnNode(id)).toEqual([[80, true]]);
  });

  test("with a live version and no domain, a cancelled Use port deploy puts the port back too", async () => {
    const id = await createApp("api");
    const live = await deploy(id);
    fleet.deployProgress(nodeA, id, live.generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    const res = await callOp(panel, serviceOps.usePort, { serviceId: id, port: 6000, fromPort: 80 }, { cookie });
    expect(res.body).toMatchObject({ domainIds: [], domainsMove: "now" });
    await fleet.settle();
    expect(row(res.body.deploymentId)?.portMove).toMatchObject({ fromPort: 80, toPort: 6000, domainIds: [], applied: true });
    expect(accessPorts(id).exposures).toEqual(["first_run:6000"]);
    const cancelled = await callOp(panel, deploymentOps.cancel, { serviceId: id, deploymentId: res.body.deploymentId }, { cookie });
    expect(cancelled.status).toBe(200);
    expect(portsOf(id)).toEqual([{ containerPort: 80, protocol: "tcp" }]);
    expect(accessPorts(id).exposures).toEqual(["first_run:80"]);
    expect(logOf(res.body.deploymentId).at(-1)).toBe(
      "ship: The service's port and its IP:port access are back on 80, where the live version listens.",
    );
  });

  test("with a live version that goes live on the new port, the domains stay moved", async () => {
    const id = await createApp("api");
    addDomain(id, "api.example.com", 80);
    const live = await deploy(id);
    fleet.deployProgress(nodeA, id, live.generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    const res = await callOp(panel, serviceOps.usePort, { serviceId: id, port: 6000 }, { cookie });
    expect(res.body.domainsMove).toBe("rollout");
    await fleet.settle();
    // An image deploy rolls out right away.
    const d = row(res.body.deploymentId);
    expect(d?.status).toBe("deploying");
    expect(domainPorts(id)).toEqual(["api.example.com:6000"]);
    fleet.deployProgress(nodeA, id, d?.generation as number, DeployStage.SUCCEEDED);
    await fleet.settle();
    expect(row(res.body.deploymentId)?.status).toBe("live");
    expect(domainPorts(id)).toEqual(["api.example.com:6000"]);
    expect(portsOf(id)).toEqual([{ containerPort: 6000, protocol: "tcp" }]);
  });

  test("is refused while a deploy runs, when the port changed since, for compose members, and without services.deploy", async () => {
    const id = await createApp("api");
    const d = await deploy(id);
    const running = await callOp(panel, serviceOps.usePort, { serviceId: id, port: 6000 }, { cookie });
    expect(running.status).toBe(409);
    expect(running.body.error.details).toEqual({ reason: "deployRunning", deploymentId: d.id, serviceId: id });
    expect(portsOf(id)).toEqual([{ containerPort: 80, protocol: "tcp" }]);
    await failOn(nodeA, id, d, reason, { notListening });

    const changed = await callOp(panel, serviceOps.usePort, { serviceId: id, port: 6000, fromPort: 3000 }, { cookie });
    expect(changed.status).toBe(409);
    expect(changed.body.error.details).toEqual({ reason: "portChanged" });
    expect(changed.body.error.message).toBe(
      "The service's port is 80 now, not 3000. Check Ports in the Container section of its Advanced tab.",
    );

    const other = await createApp("stack-member");
    panel.deps.db.update(services).set({ parentId: id }).where(eq(services.id, other)).run();
    const member = await callOp(panel, serviceOps.usePort, { serviceId: other, port: 6000 }, { cookie });
    expect(member.status).toBe(409);
    expect(member.body.error.details).toEqual({ reason: "compose" });

    const { user, cookie: memberCookie } = await createUser(panel, "member");
    grant(panel, user.id, "service", id, ["services.view", "services.update"]);
    const forbidden = await callOp(panel, serviceOps.usePort, { serviceId: id, port: 6000 }, { cookie: memberCookie });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.details).toEqual({ action: "services.deploy" });
    expect(portsOf(id)).toEqual([{ containerPort: 80, protocol: "tcp" }]);
  });
});

describe("placements and running deploys", () => {
  test("another node while a deploy runs is refused with the deploy to wait for; replica counts alone are fine", async () => {
    const id = await createApp("trust-api");
    const d = await deploy(id);
    const moved = await callOp(
      panel,
      serviceOps.setPlacements,
      { serviceId: id, placements: [{ nodeId: nodeB, replicas: 1 }] },
      { cookie },
    );
    expect(moved.status).toBe(409);
    expect(moved.body.error.details).toEqual({ reason: "deployRunning", deploymentId: d.id, serviceId: id });
    expect(moved.body.error.message).toContain("then change where it runs");
    const added = await callOp(
      panel,
      serviceOps.setPlacements,
      {
        serviceId: id,
        placements: [
          { nodeId: nodeA, replicas: 1 },
          { nodeId: nodeB, replicas: 1 },
        ],
      },
      { cookie },
    );
    expect(added.status).toBe(409);
    const scaled = await callOp(
      panel,
      serviceOps.setPlacements,
      { serviceId: id, placements: [{ nodeId: nodeA, replicas: 2 }] },
      { cookie },
    );
    expect(scaled.status).toBe(200);
    expect(panel.deps.db.select().from(servicePlacements).where(eq(servicePlacements.serviceId, id)).all()).toMatchObject([
      { nodeId: nodeA, replicas: 2 },
    ]);
    // services.move names the deploy the same way.
    fleet.deployProgress(nodeA, id, d.generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    const again = await deploy(id);
    const move = await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie });
    expect(move.status).toBe(409);
    expect(move.body.error.details).toEqual({ reason: "deployRunning", deploymentId: again.id, serviceId: id });
  });

  test("a rollout on a node that no longer holds the service fails at once", async () => {
    const id = await createApp("trust-api");
    const d = await deploy(id);
    expect(row(d.id)?.status).toBe("deploying");
    // The placement changed underneath (before 0.2.16 services.setPlacements allowed it mid-deploy).
    panel.deps.db.update(servicePlacements).set({ nodeId: nodeB }).where(eq(servicePlacements.serviceId, id)).run();
    engineFor(panel.deps).kick(d.id);
    await fleet.settle();
    const failed = row(d.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe(
      "start-app no longer runs this service: its nodes changed after this deploy started, so nothing rolls it out there. Deploy again to roll it out on il-ra.",
    );
  });

  test("the watchdog: no progress from a node for the health timeout and a margin fails the rollout", async () => {
    const id = await createApp("api");
    const d = await deploy(id);
    const back = (ms: number) => new Date(Date.now() - ms);
    // 11 minutes in, but the node reported a stage 2 minutes ago: it is rolling out.
    fleet.deployProgress(nodeA, id, d.generation, DeployStage.PULLING, "");
    await fleet.settle();
    const at = row(d.id)?.nodeResults[nodeA]?.progressAt as number;
    expect(at).toBeGreaterThan(Date.now() - 5000);
    panel.deps.db
      .update(deployments)
      .set({
        phaseStartedAt: back(11 * 60_000),
        nodeResults: { [nodeA]: { status: "pending", message: "", digest: null, progressAt: Date.now() - 2 * 60_000 } },
      })
      .where(eq(deployments.id, d.id))
      .run();
    engineFor(panel.deps).kick(d.id);
    await fleet.settle();
    expect(row(d.id)?.status).toBe("deploying");
    // Nothing for 10 minutes (the 300 s health timeout and 5 minutes), the node offline: it fails and says so.
    panel.deps.db
      .update(deployments)
      .set({ nodeResults: { [nodeA]: { status: "pending", message: "", digest: null, progressAt: Date.now() - 10 * 60_000 - 1000 } } })
      .where(eq(deployments.id, d.id))
      .run();
    fleet.online.delete(nodeA);
    engineFor(panel.deps).kick(d.id);
    await fleet.settle();
    expect(row(d.id)?.status).toBe("failed");
    expect(row(d.id)?.error).toBe("No progress from start-app for 10 minutes (start-app is offline). The previous version stayed live.");
  });

  test("however it progresses, a rollout ends three watchdog periods after it started", async () => {
    const id = await createApp("api");
    const d = await deploy(id);
    panel.deps.db
      .update(deployments)
      .set({
        phaseStartedAt: new Date(Date.now() - 31 * 60_000),
        nodeResults: { [nodeA]: { status: "pending", message: "", digest: null, progressAt: Date.now() } },
      })
      .where(and(eq(deployments.id, d.id)))
      .run();
    engineFor(panel.deps).kick(d.id);
    await fleet.settle();
    expect(row(d.id)?.error).toBe("start-app did not report the new version healthy within 30 minutes. The previous version stayed live.");
  });
});
