// A service's main port changed by hand (services.update: the Advanced
// tab's Ports, or the API), 0.2.16. Use port already moved what sent
// traffic to the old port; a port typed in did not, so the domains, the
// first-run IP:port access, timed exposes and the Cloudflare tunnel kept
// the old port and the next deploy listened where nothing pointed. Now they
// follow like they do with Use port: at once when no live version listens
// on the old port, else when the next deploy rolls out (and back if it
// fails, the port staying as set). A domain on another port stays.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deployments as deploymentOps, projects, services as serviceOps } from "@seylo/ops";
import { DeployStage } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { auditLog, cloudflareTunnels, deploymentLogs, deployments, domains, portExposures, services } from "../src/db/schema";
import { compileDesiredState } from "../src/desired/compile";
import { portBackLines } from "../src/modules/deployments/engine";
import { serviceNetworking } from "../src/modules/domains/desired";
import { mainPortChange } from "../src/modules/services/port-move";
import { readSpec } from "../src/modules/services/spec";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let node: string;

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  node = fleet.addNode("start-app");
  fleet.addNode("builder", { canBuild: true, panelNode: true });
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "csspanel" }, { cookie })).body.id;
});
afterEach(() => panel.close());

const tcp = (...ports: number[]) => ports.map((containerPort) => ({ containerPort, protocol: "tcp" as const }));

async function createApp(name: string, port = 80) {
  const res = await callOp(
    panel,
    serviceOps.create,
    {
      projectId,
      name,
      kind: "app",
      nodeId: node,
      source: { type: "image", image: "ghcr.io/acme/api:1", registryId: null },
      ports: tcp(port),
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

async function goLive(serviceId: string) {
  const d = await deploy(serviceId);
  fleet.deployProgress(node, serviceId, d.generation, DeployStage.SUCCEEDED);
  await fleet.settle();
  expect(row(d.id)?.status).toBe("live");
  return d;
}

async function fail(serviceId: string, d: { generation: number }) {
  fleet.deployProgress(node, serviceId, d.generation, DeployStage.HEALTH_CHECKING, "");
  fleet.deployProgress(node, serviceId, d.generation, DeployStage.FAILED, "not healthy after 5m0s: health check never passed");
  await fleet.settle();
}

async function setPorts(serviceId: string, ports: { containerPort: number; protocol: "tcp" | "udp" }[]) {
  const res = await callOp(panel, serviceOps.update, { serviceId, ports }, { cookie });
  expect(res.status).toBe(200);
  return res.body;
}

const row = (id: string) => panel.deps.db.select().from(deployments).where(eq(deployments.id, id)).get();
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
const domainId = (host: string) => panel.deps.db.select().from(domains).where(eq(domains.host, host)).get()?.id;
/** Where the service's IP:port access (services.create opens the first-run port) and its tunnel send traffic. */
const accessPorts = (id: string) => ({
  exposures: panel.deps.db
    .select({ kind: portExposures.kind, port: portExposures.targetPort })
    .from(portExposures)
    .where(eq(portExposures.serviceId, id))
    .orderBy(portExposures.kind, portExposures.targetPort)
    .all()
    .map((e) => `${e.kind}:${e.port}`),
  tunnel: panel.deps.db.select().from(cloudflareTunnels).where(eq(cloudflareTunnels.serviceId, id)).get()?.targetPort ?? null,
});
/** The target ports of the routes the node gets for the service. */
const routesOf = (id: string) =>
  (serviceNetworking(panel.deps, id, node).routing.routes?.map((r) => r.targetPort ?? 0) ?? []).sort((a, b) => a - b);
/** The service's container ports the node gets, and whether each carries the first-run IP:port listener. */
function portsOnNode(id: string): [number, boolean][] {
  const state = compileDesiredState(panel.deps.db, node, {
    revision: 1n,
    secrets: panel.deps.secrets,
    contributors: panel.deps.agents.desired.contributors(),
  });
  return state.services.find((x) => x.id === id)?.ports.map((p) => [p.containerPort, p.public !== undefined]) ?? [];
}
function addDomain(serviceId: string, host: string, targetPort: number) {
  panel.deps.db.insert(domains).values({ serviceId, host, targetPort, https: "off" }).run();
}
function addTunnel(serviceId: string, targetPort: number) {
  panel.deps.db.insert(cloudflareTunnels).values({ serviceId, enabled: true, mode: "quick", targetPort }).run();
}
function addTimedExpose(serviceId: string, targetPort: number) {
  panel.deps.db
    .insert(portExposures)
    .values({ serviceId, nodeId: node, kind: "timed", listenPort: 0, targetPort, expiresAt: new Date(Date.now() + 600_000) })
    .run();
}
/** What services.update recorded about the main port in its audit row (the newest one). */
const audited = () =>
  (
    panel.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.opId, serviceOps.update.id), eq(auditLog.outcome, "ok")))
      .all()
      .at(-1)?.input as { mainPort?: Record<string, unknown> } | undefined
  )?.mainPort;

describe("a main port changed by hand", () => {
  test("without a live version: the domains on it, its IP:port access and its tunnel move at once; a domain on another port stays", async () => {
    const id = await createApp("api");
    addDomain(id, "api.example.com", 80);
    addDomain(id, "admin.example.com", 8080);
    addTimedExpose(id, 80);
    addTimedExpose(id, 9090);
    addTunnel(id, 80);
    const detail = await setPorts(id, tcp(6000, 8080));
    expect(detail.ports).toEqual(tcp(6000, 8080));
    expect(domainPorts(id)).toEqual(["admin.example.com:8080", "api.example.com:6000"]);
    expect(accessPorts(id)).toEqual({ exposures: ["first_run:6000", "timed:6000", "timed:9090"], tunnel: 6000 });
    expect(routesOf(id)).toEqual([6000, 8080]);
    expect(audited()).toEqual({
      fromPort: 80,
      toPort: 6000,
      moves: "now",
      domainIds: [domainId("api.example.com")],
      exposureIds: [expect.any(String), expect.any(String)],
      tunnel: true,
    });

    // The first deploy listens where they point; nothing is left to move at its rollout.
    const d = await deploy(id);
    expect(row(d.id)?.status).toBe("deploying");
    expect(row(d.id)?.portMove).toBeNull();
    expect(portsOnNode(id)).toEqual([
      [6000, true],
      [8080, false],
    ]);
  });

  test("with a live version: they keep the old port until the next deploy rolls out, then move with it", async () => {
    const id = await createApp("api");
    addDomain(id, "api.example.com", 80);
    addDomain(id, "admin.example.com", 8080);
    addTunnel(id, 80);
    await goLive(id);
    await setPorts(id, tcp(6000));
    // Applies on the next deploy: the live version still listens on 80, and so do its routes and listener.
    expect(portsOf(id)).toEqual(tcp(6000));
    expect(domainPorts(id)).toEqual(["admin.example.com:8080", "api.example.com:80"]);
    expect(accessPorts(id)).toEqual({ exposures: ["first_run:80"], tunnel: 80 });
    expect(routesOf(id)).toEqual([80, 8080]);
    expect(portsOnNode(id)).toEqual([[80, true]]);
    expect(audited()).toMatchObject({ fromPort: 80, toPort: 6000, moves: "rollout", domainIds: [domainId("api.example.com")] });

    // An image deploy rolls out right away: the move goes out with the new generation.
    const d = await deploy(id);
    expect(row(d.id)?.status).toBe("deploying");
    expect(row(d.id)?.portMove).toEqual({
      fromPort: 80,
      toPort: 6000,
      domainIds: [domainId("api.example.com") as string],
      exposureIds: [expect.any(String)],
      tunnel: true,
      applied: true,
      keepPort: true,
    });
    expect(domainPorts(id)).toEqual(["admin.example.com:8080", "api.example.com:6000"]);
    expect(accessPorts(id)).toEqual({ exposures: ["first_run:6000"], tunnel: 6000 });
    expect(routesOf(id)).toEqual([6000, 8080]);
    expect(portsOnNode(id)).toEqual([[6000, true]]);
    expect(logOf(d.id)).toEqual(
      expect.arrayContaining([
        "ship: The service's port is 6000 now; the live version listens on 80.",
        "ship: Its domain moves to port 6000 with it.",
        "ship: Its IP:port access and its Cloudflare tunnel move to port 6000 with it.",
      ]),
    );
    fleet.deployProgress(node, id, d.generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    expect(row(d.id)?.status).toBe("live");
    expect(domainPorts(id)).toEqual(["admin.example.com:8080", "api.example.com:6000"]);

    // The live version listens on 6000 now: the deploy after it moves nothing.
    const next = await deploy(id);
    expect(row(next.id)?.portMove).toBeNull();
  });

  test("with a live version, a deploy that fails puts them back on the live version's port and keeps the port as set", async () => {
    const id = await createApp("api");
    addDomain(id, "api.example.com", 80);
    addTunnel(id, 80);
    await goLive(id);
    await setPorts(id, tcp(6000));
    const d = await deploy(id);
    expect(domainPorts(id)).toEqual(["api.example.com:6000"]);
    await fail(id, d);
    expect(row(d.id)?.status).toBe("failed");
    expect(domainPorts(id)).toEqual(["api.example.com:80"]);
    expect(accessPorts(id)).toEqual({ exposures: ["first_run:80"], tunnel: 80 });
    expect(portsOnNode(id)).toEqual([[80, true]]);
    expect(portsOf(id)).toEqual(tcp(6000));
    expect(logOf(d.id).at(-1)).toBe(
      "health: Its domains, its IP:port access and its Cloudflare tunnel are back on 80, where the live version listens.",
    );

    // The next deploy moves them again.
    const again = await deploy(id);
    expect(row(again.id)?.portMove).toMatchObject({ fromPort: 80, toPort: 6000, keepPort: true, applied: true });
    expect(domainPorts(id)).toEqual(["api.example.com:6000"]);
    // Cancelled once rolled out: back again, the port still as set.
    const cancelled = await callOp(panel, deploymentOps.cancel, { serviceId: id, deploymentId: again.id }, { cookie });
    expect(cancelled.status).toBe(200);
    expect(domainPorts(id)).toEqual(["api.example.com:80"]);
    expect(portsOf(id)).toEqual(tcp(6000));
  });

  test("a stopped service with a live version waits for the next deploy: start runs the live version on its old port", async () => {
    const id = await createApp("api");
    addDomain(id, "api.example.com", 80);
    await goLive(id);
    expect((await callOp(panel, serviceOps.stop, { serviceId: id }, { cookie })).status).toBe(200);
    await setPorts(id, tcp(6000));
    expect(domainPorts(id)).toEqual(["api.example.com:80"]);
    expect(audited()).toMatchObject({ moves: "rollout" });
    expect((await callOp(panel, serviceOps.start, { serviceId: id }, { cookie })).status).toBe(200);
    expect(portsOnNode(id)).toEqual([[80, true]]);
    expect(routesOf(id)).toEqual([80]);
    await deploy(id);
    expect(domainPorts(id)).toEqual(["api.example.com:6000"]);
    expect(portsOnNode(id)).toEqual([[6000, true]]);
  });

  test("changed again before the deploy: what points at a port nothing listens on moves at once, the live version's port at rollout", async () => {
    const id = await createApp("api");
    addDomain(id, "api.example.com", 80);
    await goLive(id);
    await setPorts(id, tcp(3000));
    // Pointed at the new port by hand meanwhile; the live version never listened there.
    addDomain(id, "new.example.com", 3000);
    await setPorts(id, tcp(6000));
    expect(domainPorts(id)).toEqual(["api.example.com:80", "new.example.com:6000"]);
    expect(audited()).toMatchObject({ fromPort: 3000, toPort: 6000, moves: "now", domainIds: [domainId("new.example.com")] });
    await deploy(id);
    expect(domainPorts(id)).toEqual(["api.example.com:6000", "new.example.com:6000"]);
  });

  test("back to the live version's port before the deploy: nothing moves", async () => {
    const id = await createApp("api");
    addDomain(id, "api.example.com", 80);
    await goLive(id);
    await setPorts(id, tcp(6000));
    await setPorts(id, tcp(80));
    expect(domainPorts(id)).toEqual(["api.example.com:80"]);
    const d = await deploy(id);
    expect(row(d.id)?.portMove).toBeNull();
    expect(domainPorts(id)).toEqual(["api.example.com:80"]);
  });

  test("the old port still among the ports, the same port, no port left or a compose member: nothing moves", async () => {
    const id = await createApp("api");
    addDomain(id, "api.example.com", 80);
    // Reordered: 80 is still a port, so what points at it still reaches the app.
    await setPorts(id, tcp(6000, 80));
    expect(domainPorts(id)).toEqual(["api.example.com:80"]);
    expect(accessPorts(id).exposures).toEqual(["first_run:80"]);
    expect(audited()).toBeUndefined();
    await setPorts(id, tcp(80));
    await setPorts(id, []);
    expect(domainPorts(id)).toEqual(["api.example.com:80"]);
    expect(audited()).toBeUndefined();
    // UDP ports are not the main port.
    expect(mainPortChange([{ containerPort: 53, protocol: "udp" }, ...tcp(80)], tcp(80))).toBeNull();
    expect(mainPortChange(tcp(80), [{ containerPort: 80, protocol: "udp" }, ...tcp(6000)])).toEqual({ fromPort: 80, toPort: 6000 });
    expect(mainPortChange([], tcp(80))).toBeNull();

    // A compose member's ports come from its compose file.
    const member = await createApp("stack-member");
    panel.deps.db.update(services).set({ parentId: id }).where(eq(services.id, member)).run();
    const refused = await callOp(panel, serviceOps.update, { serviceId: member, ports: tcp(6000) }, { cookie });
    expect(refused.status).toBe(409);
  });

  test("Use port after a port set by hand: what is on the live version's port follows too, and goes back there", async () => {
    const id = await createApp("api");
    addDomain(id, "api.example.com", 80);
    await goLive(id);
    // Set by hand to 3000, deployed, failed: the domain is back on 80, the port stays 3000.
    await setPorts(id, tcp(3000));
    const d = await deploy(id);
    await fail(id, d);
    expect(domainPorts(id)).toEqual(["api.example.com:80"]);
    expect(portsOf(id)).toEqual(tcp(3000));

    // The app listens on 6000: Use port from 3000, where nothing points.
    const res = await callOp(panel, serviceOps.usePort, { serviceId: id, port: 6000, fromPort: 3000 }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ domainIds: [], domainsMove: "now" });
    await fleet.settle();
    const move = row(res.body.deploymentId)?.portMove;
    expect(move).toMatchObject({
      fromPort: 3000,
      toPort: 6000,
      applied: true,
      follow: { fromPort: 80, domainIds: [domainId("api.example.com")], exposureIds: [expect.any(String)], tunnel: false },
    });
    expect(domainPorts(id)).toEqual(["api.example.com:6000"]);
    expect(accessPorts(id).exposures).toEqual(["first_run:6000"]);
    expect(logOf(res.body.deploymentId)).toContain("ship: Its domain moves to port 6000 with it.");

    await fail(id, { generation: row(res.body.deploymentId)?.generation as number });
    expect(domainPorts(id)).toEqual(["api.example.com:80"]);
    expect(accessPorts(id).exposures).toEqual(["first_run:80"]);
    expect(portsOf(id)).toEqual(tcp(3000));
    expect(logOf(res.body.deploymentId).slice(-2)).toEqual([
      "health: The service's port is back on 3000.",
      "health: Its domains and its IP:port access are back on 80, where the live version listens.",
    ]);
  });

  test("portBackLines", () => {
    const move = { fromPort: 80, toPort: 6000, domainIds: ["d1"], exposureIds: ["e1"], tunnel: true, applied: true };
    expect(portBackLines(move)).toEqual([
      "The service's port, its domains, its IP:port access and its Cloudflare tunnel are back on 80, where the live version listens.",
    ]);
    expect(portBackLines({ ...move, applied: false })).toEqual(["The service's port is back on 80, where the live version listens."]);
    expect(portBackLines({ ...move, exposureIds: [], tunnel: false, keepPort: true })).toEqual([
      "Its domains are back on 80, where the live version listens.",
    ]);
    // Use port from the live version's port, with more found on it at rollout: one line.
    expect(
      portBackLines({
        ...move,
        domainIds: [],
        exposureIds: [],
        tunnel: false,
        follow: { fromPort: 80, domainIds: ["d2"], exposureIds: [], tunnel: true },
      }),
    ).toEqual(["The service's port, its domains and its Cloudflare tunnel are back on 80, where the live version listens."]);
  });
});
