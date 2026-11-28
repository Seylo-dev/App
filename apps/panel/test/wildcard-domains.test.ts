// Wildcard domains (0.2.25, modules/domains/wildcard.ts): *.<base> on a
// service. What domains.add accepts and refuses, the DNS check through a
// random name under the base, the route the nodes get (only agents with
// routing.wildcard-hosts.v1), how its HTTPS reads without a Let's Encrypt
// certificate, ownership of exact names under another service's wildcard,
// route reports, Regenerate, an uploaded wildcard certificate and the
// origin check's probe name.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { domains as domainOps } from "@seylo/ops";
import { HttpsMode, RouteState } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { domains, nodes, services } from "../src/db/schema";
import { serviceNetworking } from "../src/modules/domains/desired";
import { type DnsLookups, setDnsLookups } from "../src/modules/domains/dns";
import { checkOrigin, setOriginFetch } from "../src/modules/domains/origin";
import { applyRouteStatus } from "../src/modules/domains/tracking";
import { probeHost, wildcardCapability, wildcardCovers } from "../src/modules/domains/wildcard";
import { setSetting } from "../src/settings";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
beforeEach(async () => {
  panel = testPanel();
  cookie = (await createUser(panel, "owner")).cookie;
});
afterEach(() => {
  setDnsLookups(null);
  setOriginFetch(null);
  panel.close();
});

const nodeIp = "88.214.55.20";
const cloudflare = ["104.21.10.10", "172.67.20.20"];

/**
 * DNS where every name under base answers `addresses` (a * record), and
 * the lookups asked for are kept. Exact records win, as in real DNS.
 */
function wildcardDns(
  base: string,
  addresses: string[],
  options: { exact?: Record<string, string[]>; ns?: Record<string, string[]> } = {},
): DnsLookups & { asked: string[] } {
  const asked: string[] = [];
  const answer = (name: string) => {
    if (options.exact?.[name]) return options.exact[name];
    const dot = name.indexOf(".");
    return dot > 0 && name.slice(dot + 1) === base ? addresses : [];
  };
  return {
    asked,
    resolve4: async (name) => {
      asked.push(name);
      return answer(name).filter((ip) => !ip.includes(":"));
    },
    resolve6: async () => [],
    resolveCname: async () => [],
    resolveNs: async (name) => options.ns?.[name] ?? [],
  };
}

function setup(options: { capable?: boolean } = {}) {
  const project = seedProject(panel);
  const node = seedNode(panel, { name: "il-ra", ipv4: nodeIp, wildcard: "il-1.sey.lue.my" });
  if (options.capable !== false) {
    panel.deps.db
      .update(nodes)
      .set({ facts: { capabilities: [wildcardCapability] } })
      .where(eq(nodes.id, node.id))
      .run();
  }
  const service = seedService(panel, { projectId: project.id, name: "web", ports: [3700], nodeIds: [node.id], deployed: true });
  return { project, node, service };
}

describe("wildcard hosts in domains.add", () => {
  test("accepted as *.<base>; refused elsewhere in the name, doubled, glued to a label or over a bare TLD", async () => {
    const { service } = setup();
    setDnsLookups(wildcardDns("starsell.net", cloudflare, { ns: { "starsell.net": ["ada.ns.cloudflare.com"] } }));
    const added = await callOp(panel, domainOps.add, { serviceId: service.id, host: "*.starsell.net" }, { cookie });
    expect(added.status).toBe(200);
    expect(added.body.domain).toMatchObject({
      host: "*.starsell.net",
      wildcard: true,
      primary: false,
      https: "acme",
      redirectToHttps: true,
      url: "https://*.starsell.net",
    });
    for (const host of ["a.*.starsell.net", "**.starsell.net", "*starsell.net", "*.com", "*", "*.*.starsell.net", "shop.*"]) {
      const refused = await callOp(panel, domainOps.add, { serviceId: service.id, host }, { cookie });
      expect([host, refused.status]).toEqual([host, 400]);
    }
  });

  test("a public suffix, a node's automatic-domain wildcard, the panel's domain and the panel's own service are refused", async () => {
    const { project, service } = setup();
    setSetting(panel.deps.db, "panelDomain", "panel.starsell.app");
    setDnsLookups(wildcardDns("unused.test", []));
    const refusal = async (serviceId: string, host: string) => {
      const res = await callOp(panel, domainOps.add, { serviceId, host }, { cookie });
      return [res.status, res.body.error?.details?.reason, res.body.error?.details?.field];
    };
    expect(await refusal(service.id, "*.co.il")).toEqual([400, "wildcardPublicSuffix", "host"]);
    expect(await refusal(service.id, "*.github.io")).toEqual([200, undefined, undefined]);
    expect(await refusal(service.id, "*.il-1.sey.lue.my")).toEqual([400, "wildcardNodeDomain", "host"]);
    expect(await refusal(service.id, "*.starsell.app")).toEqual([400, "wildcardPanelDomain", "host"]);
    // One level deeper does not cover panel.starsell.app.
    expect(await refusal(service.id, "*.panel.starsell.app")).toEqual([200, undefined, undefined]);
    const panelService = seedService(panel, { projectId: project.id, name: "panel", ports: [3000] });
    panel.deps.db.update(services).set({ protected: true }).where(eq(services.id, panelService.id)).run();
    expect(await refusal(panelService.id, "*.tools.starsell.net")).toEqual([400, "wildcardPanelService", "host"]);
  });

  test("never primary: refused when asked, skipped as the first domain, by setPrimary and when the primary is removed", async () => {
    const { service } = setup();
    setDnsLookups(wildcardDns("starsell.net", [nodeIp], { exact: { "starsell.app": [nodeIp] } }));
    const asked = await callOp(panel, domainOps.add, { serviceId: service.id, host: "*.starsell.net", primary: true }, { cookie });
    expect(asked.status).toBe(400);
    expect(asked.body.error.details).toEqual({ field: "primary", reason: "wildcardPrimary" });

    const wildcard = await callOp(panel, domainOps.add, { serviceId: service.id, host: "*.starsell.net" }, { cookie });
    expect(wildcard.body.domain.primary).toBe(false);
    const exact = await callOp(panel, domainOps.add, { serviceId: service.id, host: "starsell.app" }, { cookie });
    expect(exact.body.domain.primary).toBe(true);

    const set = await callOp(panel, domainOps.setPrimary, { serviceId: service.id, domainId: wildcard.body.domain.id }, { cookie });
    expect(set.status).toBe(400);
    expect(set.body.error.details.reason).toBe("wildcardPrimary");

    await callOp(panel, domainOps.remove, { serviceId: service.id, domainId: exact.body.domain.id }, { cookie });
    const listed = await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie });
    expect(listed.body.domains.map((d: { host: string; primary: boolean }) => [d.host, d.primary])).toEqual([["*.starsell.net", false]]);
  });

  test("wildcardCovers: one more label, never the base or a deeper name", () => {
    expect(wildcardCovers("*.starsell.net", "shop.starsell.net")).toBe(true);
    expect(wildcardCovers("*.starsell.net", "starsell.net")).toBe(false);
    expect(wildcardCovers("*.starsell.net", "a.b.starsell.net")).toBe(false);
    expect(wildcardCovers("*.starsell.net", "*.starsell.net")).toBe(false);
    expect(probeHost("*.starsell.net")).toMatch(/^seylo-check-[0-9a-f]{12}\.starsell\.net$/);
    expect(probeHost("shop.starsell.net")).toBe("shop.starsell.net");
  });
});

describe("the wildcard DNS check", () => {
  test("looks up a random name under the base and names the * record, for each answer", async () => {
    const { service } = setup();
    const cases: [string[], string][] = [
      [cloudflare, "proxied"],
      [[nodeIp], "ok"],
      [[], "missing"],
      [["198.51.100.7"], "wrongTarget"],
    ];
    let first: string | null = null;
    for (const [addresses, status] of cases) {
      const dns = wildcardDns("starsell.net", addresses, {
        // An exact record for shop must not decide the wildcard's answer.
        exact: { "shop.starsell.net": ["198.51.100.99"] },
        ns: { "starsell.net": ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] },
      });
      setDnsLookups(dns);
      let domainId = first;
      if (!domainId) {
        const added = await callOp(panel, domainOps.add, { serviceId: service.id, host: "*.starsell.net" }, { cookie });
        domainId = first = added.body.domain.id as string;
        expect(added.body.dns.status).toBe(status);
      }
      const check = await callOp(panel, domainOps.checkDns, { serviceId: service.id, domainId }, { cookie });
      expect(check.status).toBe(200);
      expect(check.body).toMatchObject({
        host: "*.starsell.net",
        status,
        zone: "starsell.net",
        cloudflareManaged: true,
        cloudflareDnsUrl: "https://dash.cloudflare.com/?to=/:account/starsell.net/dns/records",
        expected: [{ type: "A", name: "*", value: nodeIp }],
      });
      expect(check.body.probe).toMatch(/^seylo-check-[0-9a-f]{12}\.starsell\.net$/);
      expect(dns.asked).toContain(check.body.probe);
      expect(dns.asked).not.toContain("*.starsell.net");
      expect(check.body.found).toEqual(addresses.map((value) => ({ type: "A", name: "*", value })));
      expect(check.body.message).toContain(status === "missing" ? "named *" : "*.starsell.net");
    }
  });
});

describe("routes and HTTPS of a wildcard", () => {
  test("nodes that route wildcards get one host, no ACME hold or challenge router, the redirect to HTTPS", async () => {
    const { service, node } = setup();
    setDnsLookups(wildcardDns("starsell.net", cloudflare));
    await callOp(panel, domainOps.add, { serviceId: service.id, host: "*.starsell.net", pathPrefix: "/shop" }, { cookie });
    const net = serviceNetworking(panel.deps, service.id, node.id);
    expect(net.routing.routes).toHaveLength(1);
    expect(net.routing.routes?.[0]).toMatchObject({
      hosts: ["*.starsell.net"],
      pathPrefix: "/shop",
      targetPort: 3700,
      https: HttpsMode.ACME,
      acmeHold: false,
      acmeChallengeOnHttps: false,
      redirectToHttps: true,
    });
  });

  test("a node whose agent does not route wildcards gets the exact domains only, and the wildcard says agentTooOld", async () => {
    const { service, node } = setup({ capable: false });
    setDnsLookups(wildcardDns("starsell.net", cloudflare, { exact: { "starsell.app": [nodeIp] } }));
    const exact = await callOp(panel, domainOps.add, { serviceId: service.id, host: "starsell.app" }, { cookie });
    const added = await callOp(panel, domainOps.add, { serviceId: service.id, host: "*.starsell.net" }, { cookie });
    expect(added.status).toBe(200);
    expect(added.body.domain.noRoute).toEqual({ reason: "agentTooOld", nodeId: node.id, nodeName: "il-ra" });
    const net = serviceNetworking(panel.deps, service.id, node.id);
    expect(net.routing.routes?.map((r) => r.hosts)).toEqual([["starsell.app"]]);
    const listed = await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie });
    const byHost = new Map(listed.body.domains.map((d: { host: string }) => [d.host, d]));
    expect((byHost.get("*.starsell.net") as { noRoute: unknown }).noRoute).toMatchObject({ reason: "agentTooOld" });
    expect((byHost.get("starsell.app") as { noRoute?: unknown }).noRoute).toBeUndefined();
    expect(exact.body.domain.id).toBeTruthy();

    // Once the node advertises the capability, the route goes out.
    panel.deps.db
      .update(nodes)
      .set({ facts: { capabilities: [wildcardCapability] } })
      .where(eq(nodes.id, node.id))
      .run();
    expect(serviceNetworking(panel.deps, service.id, node.id).routing.routes?.map((r) => r.hosts)).toEqual([
      ["starsell.app"],
      ["*.starsell.net"],
    ]);
  });

  test("certificate: none from Let's Encrypt; cloudflareEdge behind the proxy, noCertificate straight to the node", async () => {
    const { service } = setup();
    setDnsLookups(wildcardDns("starsell.net", cloudflare));
    const added = await callOp(panel, domainOps.add, { serviceId: service.id, host: "*.starsell.net" }, { cookie });
    expect(added.body.domain.certificate).toEqual({
      status: "none",
      expiresAt: null,
      issuer: null,
      error: null,
      wildcard: "cloudflareEdge",
    });

    setDnsLookups(wildcardDns("starsell.net", [nodeIp]));
    await callOp(panel, domainOps.checkDns, { serviceId: service.id, domainId: added.body.domain.id }, { cookie });
    const listed = await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie });
    expect(listed.body.domains[0].certificate).toEqual({
      status: "none",
      expiresAt: null,
      issuer: null,
      error: null,
      wildcard: "noCertificate",
    });

    const off = await callOp(panel, domainOps.update, { serviceId: service.id, domainId: added.body.domain.id, https: "off" }, { cookie });
    expect(off.body.certificate).toEqual({ status: "none", expiresAt: null, issuer: null, error: null });
    expect(off.body.url).toBe("http://*.starsell.net");
    const back = await callOp(
      panel,
      domainOps.update,
      { serviceId: service.id, domainId: added.body.domain.id, https: "acme" },
      { cookie },
    );
    expect(back.body.certificate).toMatchObject({ status: "none", wildcard: "noCertificate" });
    expect(back.body.certificate.waitingForDns).toBeUndefined();
  });

  test("a redirect-only wildcard sends any one-label name to the target, keeping the path", async () => {
    const { service, node } = setup();
    setDnsLookups(wildcardDns("old-shop.net", cloudflare));
    await callOp(
      panel,
      domainOps.add,
      { serviceId: service.id, host: "*.old-shop.net", forward: { url: "https://starsell.app", permanent: true, keepPath: true } },
      { cookie },
    );
    const route = serviceNetworking(panel.deps, service.id, node.id).routing.routes?.[0];
    const from = new RegExp(route?.redirects?.[0]?.from ?? "");
    expect(route?.redirects?.[0]?.to).toBe("https://starsell.app$1");
    expect("https://north.old-shop.net/p/1?x=2".replace(from, "https://starsell.app$1")).toBe("https://starsell.app/p/1?x=2");
    expect(from.test("http://north.old-shop.net:80/")).toBe(true);
    expect(from.test("https://a.b.old-shop.net/")).toBe(false);
    expect(from.test("https://old-shop.net/")).toBe(false);
  });

  test("route reports: ACTIVE sets liveAt and nothing about a certificate; pending and failed are ignored", async () => {
    const { service } = setup();
    setDnsLookups(wildcardDns("starsell.net", cloudflare));
    const added = await callOp(panel, domainOps.add, { serviceId: service.id, host: "*.starsell.net" }, { cookie });
    const id = added.body.domain.id as string;
    const report = (state: RouteState, message = "") =>
      applyRouteStatus(panel.deps, { serviceId: service.id, routes: [{ routeId: id, state, message }] } as never);
    expect(report(RouteState.CERTIFICATE_PENDING)).toBe(false);
    expect(report(RouteState.CERTIFICATE_FAILED, "no")).toBe(false);
    expect(report(RouteState.ACTIVE)).toBe(true);
    const row = panel.deps.db.select().from(domains).where(eq(domains.id, id)).get();
    expect(row?.liveAt).toBeInstanceOf(Date);
    expect([row?.certStatus, row?.certError, row?.dnsStatus]).toEqual(["none", null, "proxied"]);
    expect(report(RouteState.ACTIVE)).toBe(false);
  });

  test("Regenerate certificate is refused: Let's Encrypt cannot issue a wildcard over HTTP-01", async () => {
    const { service } = setup();
    setDnsLookups(wildcardDns("starsell.net", [nodeIp]));
    const added = await callOp(panel, domainOps.add, { serviceId: service.id, host: "*.starsell.net" }, { cookie });
    const retry = await callOp(panel, domainOps.retryCertificate, { serviceId: service.id, domainId: added.body.domain.id }, { cookie });
    expect(retry.status).toBe(409);
    expect(retry.body.error.details.reason).toBe("wildcard");
  });

  test("an uploaded certificate must name the wildcard itself", async () => {
    const { service, node } = setup();
    setDnsLookups(wildcardDns("starsell.net", cloudflare));
    const added = await callOp(panel, domainOps.add, { serviceId: service.id, host: "*.starsell.net" }, { cookie });
    const ref = { serviceId: service.id, domainId: added.body.domain.id };
    const oneName = selfSigned(["shop.starsell.net"]);
    const refused = await callOp(panel, domainOps.setCertificate, { ...ref, certPem: oneName.cert, privateKey: oneName.key }, { cookie });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.field).toBe("certPem");
    const wildcard = selfSigned(["*.starsell.net", "starsell.net"]);
    const ok = await callOp(panel, domainOps.setCertificate, { ...ref, certPem: wildcard.cert, privateKey: wildcard.key }, { cookie });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ https: "custom", certificate: { status: "valid" } });
    expect(ok.body.certificate.wildcard).toBeUndefined();
    const route = serviceNetworking(panel.deps, service.id, node.id).routing.routes?.[0];
    expect(route).toMatchObject({ hosts: ["*.starsell.net"], https: HttpsMode.CUSTOM_CERTIFICATE });
    expect(route?.certificate?.certPem).toBe(wildcard.cert);
  });

  test("the origin check asks a random name under the base, and the proof signs that name", async () => {
    const { service } = setup();
    setDnsLookups(wildcardDns("starsell.net", cloudflare));
    const added = await callOp(panel, domainOps.add, { serviceId: service.id, host: "*.starsell.net" }, { cookie });
    const urls: string[] = [];
    setOriginFetch(async (url) => {
      urls.push(url);
      return new Response("not the node", { status: 200 });
    });
    const row = panel.deps.db.select().from(domains).where(eq(domains.id, added.body.domain.id)).get();
    if (!row) throw new Error("no row");
    panel.deps.db
      .update(nodes)
      .set({ facts: { capabilities: [wildcardCapability, "routing.origin-proof.v1"] } })
      .run();
    await checkOrigin(panel.deps, row);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? "").hostname).toMatch(/^seylo-check-[0-9a-f]{12}\.starsell\.net$/);
  });
});

describe("exact names under another service's wildcard", () => {
  test("only callers who may edit the wildcard's service add one: an exact host would take that name's requests", async () => {
    const node = seedNode(panel, { ipv4: nodeIp, wildcard: "il-1.sey.lue.my" });
    const shopProject = seedProject(panel);
    const shop = seedService(panel, { projectId: shopProject.id, name: "storefront", nodeIds: [node.id] });
    const otherProject = seedProject(panel);
    const mine = seedService(panel, { projectId: otherProject.id, name: "mine", nodeIds: [node.id] });
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", mine.id, ["domains.edit", "services.view"]);
    setDnsLookups(wildcardDns("starsell.net", cloudflare));
    expect((await callOp(panel, domainOps.add, { serviceId: shop.id, host: "*.starsell.net" }, { cookie })).status).toBe(200);

    const as = { cookie: member.cookie };
    const stolen = await callOp(panel, domainOps.add, { serviceId: mine.id, host: "north.starsell.net" }, as);
    expect(stolen.status).toBe(409);
    expect(stolen.body.error.details).toMatchObject({ field: "host", reason: "hostTaken" });
    expect(stolen.body.error.message).toContain("*.starsell.net");
    // The same wildcard is the same host: taken too.
    const twin = await callOp(panel, domainOps.add, { serviceId: mine.id, host: "*.starsell.net" }, as);
    expect(twin.status).toBe(409);
    // Deeper names and other bases are not under it.
    expect((await callOp(panel, domainOps.add, { serviceId: mine.id, host: "a.north.starsell.net" }, as)).status).toBe(200);
    // The owner may: exact beats wildcard on the node, as they chose.
    expect((await callOp(panel, domainOps.add, { serviceId: mine.id, host: "admin.starsell.net" }, { cookie })).status).toBe(200);
  });

  test("a wildcard over names another service routes is refused to callers who may not edit that service", async () => {
    const node = seedNode(panel, { ipv4: nodeIp, wildcard: "il-1.sey.lue.my" });
    const victim = seedService(panel, { projectId: seedProject(panel).id, name: "shop", nodeIds: [node.id] });
    const mine = seedService(panel, { projectId: seedProject(panel).id, name: "mine", nodeIds: [node.id] });
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", mine.id, ["domains.edit", "services.view"]);
    setDnsLookups(wildcardDns("victim.net", [nodeIp], { exact: { "shop.victim.net": [nodeIp] } }));
    expect((await callOp(panel, domainOps.add, { serviceId: victim.id, host: "shop.victim.net" }, { cookie })).status).toBe(200);

    const squat = await callOp(panel, domainOps.add, { serviceId: mine.id, host: "*.victim.net" }, { cookie: member.cookie });
    expect(squat.status).toBe(409);
    expect(squat.body.error.details).toMatchObject({ field: "host", reason: "hostTaken" });
    // A deeper wildcard does not cover shop.victim.net; the owner may add either.
    expect((await callOp(panel, domainOps.add, { serviceId: mine.id, host: "*.eu.victim.net" }, { cookie: member.cookie })).status).toBe(
      200,
    );
    expect((await callOp(panel, domainOps.add, { serviceId: mine.id, host: "*.victim.net" }, { cookie })).status).toBe(200);
  });
});

function selfSigned(hosts: string[]): { cert: string; key: string } {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/wildcard-cert-${crypto.randomUUID()}`;
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
