// The networking contributor in the real desired-state compiler: routes, IP:port
// access, timed exposes, tunnels, env and the database/Box kind specs as a
// node gets them.

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  boxes as boxOps,
  databases as dbOps,
  domains as domainOps,
  env as envOps,
  exposures as exposureOps,
  maintenance as maintenanceOps,
} from "@seylo/ops";
import { DatabaseEngine, HttpsMode, PublicPortMode } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { deployments, services } from "../src/db/schema";
import { compileDesiredState } from "../src/desired/compile";
import { setDnsLookups } from "../src/modules/domains/dns";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService, settleDeploys } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
beforeEach(async () => {
  panel = testPanel();
  cookie = (await createUser(panel, "owner")).cookie;
  // shop.example.com points at the node (seedNode's address), so its route asks Let's Encrypt (acme-hold.test.ts has the ones that wait).
  setDnsLookups({
    resolve4: async (name) => (name === "shop.example.com" ? ["203.0.113.10"] : []),
    resolve6: async () => [],
    resolveCname: async () => [],
    resolveNs: async () => [],
  });
});
afterEach(async () => {
  setDnsLookups(null);
  await settleDeploys(panel);
  panel.close();
});

test("a node's desired state carries every networking part", async () => {
  const project = seedProject(panel);
  const node = seedNode(panel, { wildcard: "n1.example.com" });
  const app = seedService(panel, { projectId: project.id, name: "web", ports: [3000], nodeIds: [node.id] });
  const db = await callOp(panel, dbOps.create, { projectId: project.id, name: "db", engine: "postgres", nodeId: node.id }, { cookie });
  const box = await callOp(panel, boxOps.create, { projectId: project.id, name: "dev", nodeId: node.id }, { cookie });
  await settleDeploys(panel);
  // The services module compiles a service once it has a target deployment with an image; pretend these went live.
  for (const [serviceId, image] of [
    [app.id, "nginx:1.27"],
    [db.body.serviceId, "postgres:17.6-alpine"],
    [box.body.serviceId, "codercom/code-server:4.96.4"],
  ] as const) {
    const row = panel.deps.db
      .insert(deployments)
      .values({ serviceId, generation: 9, status: "live", trigger: "manual", imageRef: image, imageDigest: "sha256:abc" })
      .returning()
      .get();
    panel.deps.db.update(services).set({ targetDeploymentId: row.id }).where(eq(services.id, serviceId)).run();
  }

  await callOp(panel, domainOps.add, { serviceId: app.id, host: "shop.example.com" }, { cookie });
  await callOp(panel, exposureOps.setFirstRun, { serviceId: app.id, open: true }, { cookie });
  await callOp(
    panel,
    exposureOps.openTimed,
    { serviceId: app.id, targetPort: 3000, durationMinutes: 10, allowedCidrs: ["198.51.100.7"] },
    { cookie },
  );
  await callOp(panel, envOps.set, { serviceId: app.id, text: "DATABASE_URL=${{db.INTERNAL_URL}}\n" }, { cookie });
  await callOp(panel, maintenanceOps.setGlobal, { enabled: true, message: "Back at noon" }, { cookie });

  const state = compileDesiredState(panel.deps.db, node.id, {
    revision: 7n,
    secrets: panel.deps.secrets,
    contributors: panel.deps.agents.desired.contributors(),
  });
  const web = state.services.find((s) => s.id === app.id);
  expect(web?.routing?.routes.map((r) => [r.hosts[0], r.https, r.targetPort])).toEqual([["shop.example.com", HttpsMode.ACME, 3000]]);
  expect(web?.routing?.statusPage?.enabled).toBe(true);
  expect(web?.ports[0]?.public).toMatchObject({ mode: PublicPortMode.FORWARD, hostPort: 0 });
  expect(web?.devAccess?.timedExposes[0]).toMatchObject({ containerPort: 3000, allowedSourceCidrs: ["198.51.100.7/32"] });
  const conn = await callOp(panel, dbOps.connection, { serviceId: db.body.serviceId }, { cookie });
  expect(web?.env).toEqual([expect.objectContaining({ name: "DATABASE_URL", value: conn.body.internal.url, secret: true })]);

  const pg = state.services.find((s) => s.id === db.body.serviceId);
  expect(pg?.kindSpec).toMatchObject({
    case: "database",
    value: { engine: DatabaseEngine.POSTGRES, credentials: { adminUser: "postgres" } },
  });
  expect(pg?.env.map((v) => v.name).sort()).toEqual(["POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER"]);
  const dev = state.services.find((s) => s.id === box.body.serviceId);
  expect(dev?.kindSpec).toMatchObject({ case: "box", value: { workspaceVolume: "home" } });

  expect(state.settings?.maintenance?.enabled).toBe(true);
  expect(state.settings?.maintenance?.html).toContain("Back at noon");
});
