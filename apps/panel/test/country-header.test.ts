// The visitor country header (X-Seylo-Country): the panel-wide switch and
// MaxMind account (countryHeader.get/update), the per-service toggle
// (services.setCountryHeader), and what reaches the nodes:
// NodeSettings.country_header and Routing.no_country_header.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { countryHeader, projects, services as serviceOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { auditLog, domains, settings } from "../src/db/schema";
import { compileDesiredState } from "../src/desired";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { seedService } from "./hub-helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let nodeA: string;
let projectId: string;

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
});
afterEach(() => panel.close());

const compile = (nodeId = nodeA) =>
  compileDesiredState(panel.deps.db, nodeId, {
    revision: 1n,
    secrets: panel.deps.secrets,
    contributors: panel.deps.agents.desired.contributors(),
  });

function webService() {
  const svc = seedService(panel, projectId, nodeA, { name: "web", spec: { ports: [{ containerPort: 3000, protocol: "tcp" }] } });
  panel.deps.db.insert(domains).values({ serviceId: svc.id, host: "shop.example.com", targetPort: 3000 }).run();
  return svc;
}

describe("countryHeader settings", () => {
  test("on by default, for every node", async () => {
    const got = await callOp(panel, countryHeader.get, {}, { cookie });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ enabled: true, maxmindAccountId: null, maxmindLicenseKeySet: false });
    expect(got.body.nodes.map((n: { name: string }) => n.name)).toEqual(["node-a"]);
    expect(compile().settings?.countryHeader).toMatchObject({ enabled: true, maxmindAccountId: "", maxmindLicenseKey: "" });
  });

  test("turning it off reaches every node", async () => {
    const off = await callOp(panel, countryHeader.update, { enabled: false }, { cookie });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect(compile().settings?.countryHeader?.enabled).toBe(false);
    const on = await callOp(panel, countryHeader.update, { enabled: true }, { cookie });
    expect(on.body.enabled).toBe(true);
    expect(compile().settings?.countryHeader?.enabled).toBe(true);
  });

  test("the MaxMind key is sealed, never returned, and only sent with its account", async () => {
    const set = await callOp(panel, countryHeader.update, { maxmindAccountId: "123456", maxmindLicenseKey: "abcDEF_123456" }, { cookie });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ maxmindAccountId: "123456", maxmindLicenseKeySet: true });
    expect(JSON.stringify(set.body)).not.toContain("abcDEF_123456");
    const row = panel.deps.db.select().from(settings).where(eq(settings.key, "countryHeader")).get();
    expect(JSON.stringify(row?.value)).not.toContain("abcDEF_123456");
    expect(compile().settings?.countryHeader).toMatchObject({
      enabled: true,
      maxmindAccountId: "123456",
      maxmindLicenseKey: "abcDEF_123456",
    });
    // The audit log keeps the change, not the key.
    const audited = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "countryHeader.update")).all();
    expect(audited.length).toBeGreaterThan(0);
    expect(JSON.stringify(audited)).not.toContain("abcDEF_123456");

    // Without the account ID the key is not sent.
    await callOp(panel, countryHeader.update, { maxmindAccountId: null }, { cookie });
    expect(compile().settings?.countryHeader).toMatchObject({ maxmindAccountId: "", maxmindLicenseKey: "" });
    // Off: no account either.
    await callOp(panel, countryHeader.update, { maxmindAccountId: "123456", enabled: false }, { cookie });
    expect(compile().settings?.countryHeader).toMatchObject({ enabled: false, maxmindLicenseKey: "" });
    // Removing the key.
    const removed = await callOp(panel, countryHeader.update, { maxmindLicenseKey: null }, { cookie });
    expect(removed.body.maxmindLicenseKeySet).toBe(false);
  });

  test("a key without an account ID is refused, and bad values are", async () => {
    expect((await callOp(panel, countryHeader.update, { maxmindLicenseKey: "abcDEF_123456" }, { cookie })).status).toBe(400);
    expect((await callOp(panel, countryHeader.update, { maxmindAccountId: "12ab" }, { cookie })).status).toBe(400);
    expect((await callOp(panel, countryHeader.update, { maxmindAccountId: "1", maxmindLicenseKey: "bad key!" }, { cookie })).status).toBe(
      400,
    );
  });

  test("members cannot change it", async () => {
    const { cookie: member } = await createUser(panel, "member");
    expect((await callOp(panel, countryHeader.update, { enabled: false }, { cookie: member })).status).toBe(403);
  });
});

describe("services.setCountryHeader", () => {
  test("a service can leave the header out; routing says so", async () => {
    const svc = webService();
    const routing = () => compile().services.find((s) => s.id === svc.id)?.routing;
    expect(routing()?.routes.length).toBe(1);
    expect(routing()?.noCountryHeader).toBe(false);
    expect((await callOp(panel, serviceOps.get, { serviceId: svc.id }, { cookie })).body.countryHeader).toBe(true);

    const off = await callOp(panel, serviceOps.setCountryHeader, { serviceId: svc.id, enabled: false }, { cookie });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ countryHeader: false });
    expect(routing()?.noCountryHeader).toBe(true);
    expect((await callOp(panel, serviceOps.get, { serviceId: svc.id }, { cookie })).body.countryHeader).toBe(false);

    await callOp(panel, serviceOps.setCountryHeader, { serviceId: svc.id, enabled: true }, { cookie });
    expect(routing()?.noCountryHeader).toBe(false);
  });

  test("members without the grant cannot change it", async () => {
    const svc = webService();
    const { cookie: member } = await createUser(panel, "member");
    expect((await callOp(panel, serviceOps.setCountryHeader, { serviceId: svc.id, enabled: false }, { cookie: member })).status).toBe(403);
  });
});
