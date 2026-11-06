import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { boxes as boxOps, exposures as exposureOps, maintenance as maintenanceOps, tunnels as tunnelOps } from "@seylo/ops";
import { ServicePhase } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { portExposures, services, users } from "../src/db/schema";
import { runOpAs } from "../src/modules/approvals/run-as";
import { boxRuntime } from "../src/modules/boxes/desired";
import { edgeSubject, verifyEdgeTicket } from "../src/modules/databases/edge-ticket";
import { globalMaintenance, serviceNetworking } from "../src/modules/domains/desired";
import { resolveServiceEnv } from "../src/modules/env/desired";
import { sweepAndMark } from "../src/modules/exposures/logic";
import { expireTunnels } from "../src/modules/tunnels";
import { ensureEdgeTicketKey } from "../src/security/edge-ticket-key";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, seedService, settleDeploys } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
beforeEach(async () => {
  panel = testPanel();
  cookie = (await createUser(panel, "owner", "owner@example.com")).cookie;
});
afterEach(async () => {
  await settleDeploys(panel);
  panel.close();
});

function setup() {
  const project = seedProject(panel);
  const node = seedNode(panel, { name: "de-fsn-1", ipv4: "203.0.113.10", wildcard: "n1.example.com" });
  const service = seedService(panel, { projectId: project.id, name: "web", ports: [3000], nodeIds: [node.id] });
  return { project, node, service };
}

describe("exposures", () => {
  test("an expose the assistant opens says so", async () => {
    const { service } = setup();
    const owner = panel.deps.db.select().from(users).get();
    const res = await runOpAs(panel.deps, {
      op: exposureOps.openTimed,
      input: { serviceId: service.id, targetPort: 3000, durationMinutes: 30, allowedCidrs: ["198.51.100.7"] },
      userId: owner?.id ?? "",
      transport: "ai",
    });
    expect(res.ok).toBe(true);
    expect(res.ok && (res.output as { openedBy: unknown }).openedBy).toEqual({ kind: "ai", name: "owner" });
    expect(panel.deps.db.select().from(portExposures).where(eq(portExposures.serviceId, service.id)).get()?.openedVia).toBe("ai");
  });

  test("timed exposes are locked to CIDRs, reach the agent, extend, close and expire", async () => {
    const { service, node } = setup();
    // No caller address over this transport: the caller must say who may connect.
    const noIp = await callOp(panel, exposureOps.openTimed, { serviceId: service.id, targetPort: 3000, durationMinutes: 30 }, { cookie });
    expect(noIp.status).toBe(400);
    const opened = await callOp(
      panel,
      exposureOps.openTimed,
      { serviceId: service.id, targetPort: 3000, durationMinutes: 30, allowedCidrs: ["198.51.100.7"], port: 41000 },
      { cookie },
    );
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      host: "203.0.113.10",
      port: 41000,
      allowedCidrs: ["198.51.100.7/32"],
      openedBy: { kind: "user", name: "owner" },
    });
    const clash = await callOp(
      panel,
      exposureOps.openTimed,
      { serviceId: service.id, targetPort: 3000, durationMinutes: 30, allowedCidrs: ["198.51.100.8"], port: 41000 },
      { cookie },
    );
    expect(clash.status).toBe(409);

    const dev = serviceNetworking(panel.deps, service.id, node.id).devAccess;
    expect(dev.timedExposes).toEqual([
      expect.objectContaining({ id: opened.body.id, containerPort: 3000, hostPort: 41000, allowedSourceCidrs: ["198.51.100.7/32"] }),
    ]);

    const extended = await callOp(
      panel,
      exposureOps.extendTimed,
      { serviceId: service.id, exposureId: opened.body.id, durationMinutes: 600 },
      { cookie },
    );
    expect(new Date(extended.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 3600_000);
    const listed = await callOp(panel, exposureOps.get, { serviceId: service.id }, { cookie });
    expect(listed.body.timed).toHaveLength(1);

    // Ended exposes disappear from the desired state and are swept.
    const later = new Date(Date.now() + 11 * 3600_000);
    expect(serviceNetworking(panel.deps, service.id, node.id, later).devAccess.timedExposes).toEqual([]);
    expect(sweepAndMark(panel.deps, later)).toBe(1);
    expect((await callOp(panel, exposureOps.get, { serviceId: service.id }, { cookie })).body.timed).toEqual([]);

    const second = await callOp(
      panel,
      exposureOps.openTimed,
      { serviceId: service.id, targetPort: 3000, durationMinutes: 5, allowedCidrs: ["10.0.0.0/8"] },
      { cookie },
    );
    expect(second.body.port).toBeNull();
    expect((await callOp(panel, exposureOps.close, { serviceId: service.id, exposureId: second.body.id }, { cookie })).status).toBe(200);
    expect((await callOp(panel, exposureOps.close, { serviceId: service.id, exposureId: second.body.id }, { cookie })).status).toBe(404);
  });

  test("first-run access opens on the main port, shows the picked port and closes", async () => {
    const { service, node, project } = setup();
    const noPort = seedService(panel, { projectId: project.id, name: "worker", ports: [], nodeIds: [node.id] });
    expect((await callOp(panel, exposureOps.get, { serviceId: noPort.id }, { cookie })).body.firstRun.status).toBe("none");
    expect((await callOp(panel, exposureOps.setFirstRun, { serviceId: noPort.id, open: true }, { cookie })).status).toBe(409);

    const opened = await callOp(
      panel,
      exposureOps.setFirstRun,
      { serviceId: service.id, open: true, redirectToPrimary: false },
      { cookie },
    );
    expect(opened.body).toMatchObject({ status: "open", address: null, closeWhenDomainLive: true, redirectToPrimary: false });
    const agent = fakeAgent(panel, node.id);
    agent.snapshot({ epoch: 1n, services: [{ serviceId: service.id, openPorts: [{ hostPort: 40123, containerPort: 3000 }] }] });
    expect((await callOp(panel, exposureOps.get, { serviceId: service.id }, { cookie })).body.firstRun.address).toBe("203.0.113.10:40123");
    expect(serviceNetworking(panel.deps, service.id, node.id).publicPorts).toEqual([
      expect.objectContaining({ containerPort: 3000, hostPort: 40123 }),
    ]);

    const closed = await callOp(panel, exposureOps.setFirstRun, { serviceId: service.id, open: false }, { cookie });
    expect(closed.body.status).toBe("closed");
    expect(serviceNetworking(panel.deps, service.id, node.id).publicPorts).toEqual([]);
    agent.disconnect();
  });
});

describe("tunnels", () => {
  test("quick tunnels start, report their URL and end on time", async () => {
    const { service, node } = setup();
    const off = await callOp(panel, tunnelOps.get, { serviceId: service.id }, { cookie });
    expect(off.body).toMatchObject({ enabled: false, state: "off", mode: "quick", targetPort: 3000, tokenSource: "none" });

    const on = await callOp(panel, tunnelOps.set, { serviceId: service.id, enabled: true, durationMinutes: 60 }, { cookie });
    expect(on.body).toMatchObject({ enabled: true, state: "starting", url: null });
    expect(new Date(on.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(serviceNetworking(panel.deps, service.id, node.id).devAccess.cloudflareTunnel).toEqual({
      enabled: true,
      token: "",
      targetPort: 3000,
    });

    const agent = fakeAgent(panel, node.id);
    agent.snapshot({ epoch: 1n, services: [{ serviceId: service.id, tunnelUrl: "https://quiet-river.trycloudflare.com" }] });
    const running = await callOp(panel, tunnelOps.get, { serviceId: service.id }, { cookie });
    expect(running.body).toMatchObject({ state: "running", url: "https://quiet-river.trycloudflare.com" });

    expect(expireTunnels(panel.deps, new Date(Date.now() + 2 * 3600_000))).toBe(1);
    expect((await callOp(panel, tunnelOps.get, { serviceId: service.id }, { cookie })).body).toMatchObject({
      enabled: false,
      state: "off",
      url: null,
    });
    expect(serviceNetworking(panel.deps, service.id, node.id).devAccess.cloudflareTunnel).toBeUndefined();
    agent.disconnect();
  });

  test("token mode uses the service's token, else the global one", async () => {
    const { service, node } = setup();
    const none = await callOp(panel, tunnelOps.set, { serviceId: service.id, enabled: true, mode: "token" }, { cookie });
    expect(none.status).toBe(400);

    const global = await callOp(panel, tunnelOps.setSettings, { token: "global-token-0123456789abcdef" }, { cookie });
    expect(global.body.tokenSet).toBe(true);
    const viaGlobal = await callOp(
      panel,
      tunnelOps.set,
      { serviceId: service.id, enabled: true, mode: "token", hostname: "app.example.com" },
      { cookie },
    );
    expect(viaGlobal.body).toMatchObject({ state: "running", tokenSource: "global", url: "https://app.example.com", expiresAt: null });
    expect(serviceNetworking(panel.deps, service.id, node.id).devAccess.cloudflareTunnel?.token).toBe("global-token-0123456789abcdef");

    const own = await callOp(
      panel,
      tunnelOps.set,
      { serviceId: service.id, enabled: true, token: "service-token-0123456789abcdef" },
      { cookie },
    );
    expect(own.body.tokenSource).toBe("service");
    expect(JSON.stringify(own.body)).not.toContain("service-token");
    expect(serviceNetworking(panel.deps, service.id, node.id).devAccess.cloudflareTunnel?.token).toBe("service-token-0123456789abcdef");

    expect((await callOp(panel, tunnelOps.setSettings, { token: null }, { cookie })).body).toEqual({ tokenSet: false, updatedAt: null });
    expect((await callOp(panel, tunnelOps.getSettings, {}, { cookie })).body.tokenSet).toBe(false);
  });
});

describe("maintenance", () => {
  test("global and per-service pages, previews and what the nodes get", async () => {
    const { service, node } = setup();
    expect(globalMaintenance(panel.deps.db).enabled).toBe(false);
    panel.deps.agents.desired.takeDirty();
    const global = await callOp(panel, maintenanceOps.setGlobal, { enabled: true, message: "Upgrading <db> tonight" }, { cookie });
    expect(global.body).toMatchObject({ enabled: true, message: "Upgrading <db> tonight", html: null });
    expect(panel.deps.agents.desired.takeDirty()).toEqual([{ all: true }]);
    const nodePage = globalMaintenance(panel.deps.db);
    expect(nodePage.enabled).toBe(true);
    expect(nodePage.html).toContain("Upgrading &#60;db&#62; tonight");

    const before = await callOp(panel, maintenanceOps.get, { serviceId: service.id }, { cookie });
    expect(before.body).toMatchObject({ enabled: false, pageSource: "default", globalEnabled: true });
    const own = await callOp(panel, maintenanceOps.set, { serviceId: service.id, enabled: true, html: "<h1>Shop closed</h1>" }, { cookie });
    expect(own.body).toMatchObject({ enabled: true, pageSource: "service", html: "<h1>Shop closed</h1>" });
    const routing = serviceNetworking(panel.deps, service.id, node.id).routing;
    expect(routing.maintenance).toEqual({ enabled: true, html: "<h1>Shop closed</h1>" });
    expect(routing.statusPage).toEqual({ enabled: true, html: "<h1>Shop closed</h1>" });
    expect((await callOp(panel, maintenanceOps.preview, { serviceId: service.id }, { cookie })).body.html).toBe("<h1>Shop closed</h1>");

    const back = await callOp(panel, maintenanceOps.set, { serviceId: service.id, html: null }, { cookie });
    expect(back.body.pageSource).toBe("default");
    await callOp(panel, maintenanceOps.setGlobal, { html: "<p>global</p>" }, { cookie });
    expect((await callOp(panel, maintenanceOps.get, { serviceId: service.id }, { cookie })).body.pageSource).toBe("global");

    panel.deps.db.update(services).set({ protected: true }).where(eq(services.id, service.id)).run();
    expect((await callOp(panel, maintenanceOps.set, { serviceId: service.id, enabled: true }, { cookie })).status).toBe(400);

    const member = await createUser(panel, "member");
    expect((await callOp(panel, maintenanceOps.preview, { serviceId: service.id }, { cookie: member.cookie })).status).toBe(403);
    expect((await callOp(panel, maintenanceOps.preview, {}, { cookie: member.cookie })).status).toBe(200);
    grant(panel, member.user.id, "service", service.id, ["services.view"]);
    expect((await callOp(panel, maintenanceOps.preview, { serviceId: service.id }, { cookie: member.cookie })).status).toBe(200);
  });
});

describe("boxes", () => {
  test("a Box is a code-server service opened with an edge ticket", async () => {
    const project = seedProject(panel);
    const node = seedNode(panel, { wildcard: "n1.example.com" });
    const created = await callOp(
      panel,
      boxOps.create,
      { projectId: project.id, name: "dev", nodeId: node.id, repository: "https://github.com/acme/shop.git", idleMinutes: 45 },
      { cookie },
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      name: "dev",
      nodeId: node.id,
      state: "starting",
      repository: "https://github.com/acme/shop.git",
      idleMinutes: 45,
    });
    const serviceId = created.body.serviceId;
    const row = panel.deps.db.select().from(services).where(eq(services.id, serviceId)).get();
    expect(row?.kind).toBe("box");
    expect(JSON.stringify(row?.spec)).toContain("--auth none");
    expect(boxRuntime(panel.deps, serviceId)).toEqual({ box: { workspaceVolume: "home", idleTimeout: { seconds: 2700n } } });
    expect(resolveServiceEnv(panel.deps, serviceId)).toContainEqual({
      name: "BOX_REPOSITORY",
      value: "https://github.com/acme/shop.git",
      secret: true,
    });

    const agent = fakeAgent(panel, node.id);
    agent.snapshot({ epoch: 1n, services: [{ serviceId, phase: ServicePhase.SLEEPING }] });
    expect((await callOp(panel, boxOps.get, { serviceId }, { cookie })).body.state).toBe("sleeping");

    const link = await callOp(panel, boxOps.open, { serviceId }, { cookie });
    const url = new URL(link.body.url);
    expect(url.host).toBe(`seylo-box-${serviceId}.n1.example.com`);
    const { publicKey } = ensureEdgeTicketKey(panel.deps.db, panel.deps.secrets);
    expect(verifyEdgeTicket(publicKey, url.searchParams.get("t") ?? "", edgeSubject("box", serviceId))).not.toBeNull();

    const stopped = await callOp(panel, boxOps.stop, { serviceId }, { cookie });
    expect(stopped.body.state).toBe("stopped");
    await callOp(panel, boxOps.open, { serviceId }, { cookie });
    expect(panel.deps.db.select().from(services).where(eq(services.id, serviceId)).get()?.stopped).toBe(false);
    expect((await callOp(panel, boxOps.get, { serviceId }, { cookie })).body.lastUsedAt).not.toBeNull();

    const noWildcard = seedNode(panel, { wildcard: null });
    const other = await callOp(panel, boxOps.create, { projectId: project.id, name: "dev2", nodeId: noWildcard.id }, { cookie });
    const refused = await callOp(panel, boxOps.open, { serviceId: other.body.serviceId }, { cookie });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("noWildcardDomain");
    agent.disconnect();
  });
});
