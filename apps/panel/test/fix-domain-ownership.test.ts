// A host belongs to the service that routes it: members with domains.edit on
// their own service cannot add the panel's domain, the agents' tool hosts or
// paths under another tenant's host (Traefik ranks longer rules first).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { databases as dbOps, domains as domainOps, settings as settingsOps } from "@seylo/ops";
import { serviceDatabases } from "../src/db/schema";
import { type DnsLookups, setDnsLookups } from "../src/modules/domains/dns";
import { certificateNames, sanCovers } from "../src/modules/domains/ownership";
import { setSetting } from "../src/settings";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
let owner: string;
beforeEach(async () => {
  panel = testPanel();
  owner = (await createUser(panel, "owner")).cookie;
  const none: DnsLookups = { resolve4: async () => [], resolve6: async () => [], resolveCname: async () => [], resolveNs: async () => [] };
  setDnsLookups(none);
});
afterEach(() => {
  setDnsLookups(null);
  panel.close();
});

async function setup() {
  const node = seedNode(panel, { wildcard: "n1.example.com" });
  const victimProject = seedProject(panel);
  const victim = seedService(panel, { projectId: victimProject.id, name: "shop", nodeIds: [node.id] });
  const attackerProject = seedProject(panel);
  const mine = seedService(panel, { projectId: attackerProject.id, name: "mine", nodeIds: [node.id] });
  const member = await createUser(panel, "member");
  grant(panel, member.user.id, "service", mine.id, ["domains.edit", "services.view"]);
  return { node, victim, mine, member };
}

describe("host ownership", () => {
  test("a member cannot take the panel domain, a tool host or a path on another tenant's host", async () => {
    const { victim, mine, member } = await setup();
    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    const victimDomain = await callOp(panel, domainOps.add, { serviceId: victim.id, host: "shop.example.com" }, { cookie: owner });
    expect(victimDomain.status).toBe(200);

    const as = { cookie: member.cookie };
    const panelRoot = await callOp(panel, domainOps.add, { serviceId: mine.id, host: "panel.example.com" }, as);
    expect(panelRoot.status).toBe(409);
    expect(panelRoot.body.error.details.reason).toBe("panelDomain");
    const panelApi = await callOp(panel, domainOps.add, { serviceId: mine.id, host: "panel.example.com", pathPrefix: "/api" }, as);
    expect(panelApi.status).toBe(409);

    const stolenPath = await callOp(panel, domainOps.add, { serviceId: mine.id, host: "shop.example.com", pathPrefix: "/api" }, as);
    expect(stolenPath.status).toBe(409);
    expect(stolenPath.body.error.details.reason).toBe("hostTaken");

    const toolHost = await callOp(
      panel,
      domainOps.add,
      { serviceId: mine.id, host: `seylo-db-${victim.id}.n1.example.com`, pathPrefix: "/_seylo" },
      as,
    );
    expect(toolHost.status).toBe(409);
    expect(toolHost.body.error.details.reason).toBe("reserved");
    const autoTool = await callOp(panel, domainOps.addAuto, { serviceId: mine.id, subdomain: `seylo-box-${victim.id}` }, as);
    expect(autoTool.status).toBe(409);

    // Their own new host still works.
    expect((await callOp(panel, domainOps.add, { serviceId: mine.id, host: "mine.example.com" }, as)).status).toBe(200);
  });

  test("changing a path on a host shared with a service the caller cannot edit is refused", async () => {
    const { victim, mine, member } = await setup();
    await callOp(panel, domainOps.add, { serviceId: victim.id, host: "shared.example.com" }, { cookie: owner });
    // The owner may split one host between services (root everywhere anyway).
    const split = await callOp(
      panel,
      domainOps.add,
      { serviceId: mine.id, host: "shared.example.com", pathPrefix: "/docs" },
      { cookie: owner },
    );
    expect(split.status).toBe(200);
    const moved = await callOp(
      panel,
      domainOps.update,
      { serviceId: mine.id, domainId: split.body.domain.id, pathPrefix: `/${"a".repeat(40)}` },
      { cookie: member.cookie },
    );
    expect(moved.status).toBe(409);
  });

  test("the panel domain and database TLS host names cannot be service hosts", async () => {
    const { victim } = await setup();
    await callOp(panel, domainOps.add, { serviceId: victim.id, host: "taken.example.com" }, { cookie: owner });
    const general = await callOp(panel, settingsOps.updateGeneral, { domain: "taken.example.com" }, { cookie: owner });
    expect(general.status).toBe(409);

    panel.deps.db
      .insert(serviceDatabases)
      .values({
        serviceId: victim.id,
        engine: "postgres",
        version: "17",
        adminUser: "postgres",
        exposedUser: "ext",
        tlsHostname: "db.example.com",
      })
      .run();
    const node = seedNode(panel);
    const other = seedService(panel, { projectId: seedProject(panel).id, name: "other", nodeIds: [node.id] });
    const dbHost = await callOp(panel, domainOps.add, { serviceId: other.id, host: "db.example.com" }, { cookie: owner });
    expect(dbHost.status).toBe(409);
    expect(dbHost.body.error.details.reason).toBe("databaseHost");
    expect(dbOps.setExposure.id).toBe("databases.setExposure");
  });

  test("certificate names and wildcard matching", () => {
    expect(sanCovers("*.example.com", "shop.example.com")).toBe(true);
    expect(sanCovers("*.example.com", "a.shop.example.com")).toBe(false);
    expect(sanCovers("shop.example.com", "shop.example.com")).toBe(true);
    expect(certificateNames("not a cert")).toEqual([]);
  });

  test("a custom certificate may not name the panel domain or another tenant's host", async () => {
    const { victim, mine, member } = await setup();
    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    await callOp(panel, domainOps.add, { serviceId: victim.id, host: "shop.example.com" }, { cookie: owner });
    const own = await callOp(
      panel,
      domainOps.add,
      { serviceId: mine.id, host: "mine.example.com", https: "off" },
      { cookie: member.cookie },
    );
    expect(own.status).toBe(200);
    const sans = ["mine.example.com", "panel.example.com", "shop.example.com"];
    const pem = selfSigned(sans);
    const upload = await callOp(
      panel,
      domainOps.setCertificate,
      { serviceId: mine.id, domainId: own.body.domain.id, certPem: pem.cert, privateKey: pem.key },
      { cookie: member.cookie },
    );
    expect(upload.status).toBe(400);
    expect(upload.body.error.details.field).toBe("certPem");
    const clean = selfSigned(["mine.example.com"]);
    const ok = await callOp(
      panel,
      domainOps.setCertificate,
      { serviceId: mine.id, domainId: own.body.domain.id, certPem: clean.cert, privateKey: clean.key },
      { cookie: member.cookie },
    );
    expect(ok.status).toBe(200);
  });
});

function selfSigned(hosts: string[]): { cert: string; key: string } {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/own-cert-${crypto.randomUUID()}`;
  Bun.spawnSync(["mkdir", "-p", dir]);
  const run = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "30",
    "-subj",
    `/CN=${hosts[0]}`,
    "-addext",
    `subjectAltName=${hosts.map((h) => `DNS:${h}`).join(",")}`,
    "-keyout",
    `${dir}/key.pem`,
    "-out",
    `${dir}/cert.pem`,
  ]);
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  const fs = require("node:fs");
  const out = { cert: fs.readFileSync(`${dir}/cert.pem`, "utf8"), key: fs.readFileSync(`${dir}/key.pem`, "utf8") };
  Bun.spawnSync(["rm", "-rf", dir]);
  return out;
}
