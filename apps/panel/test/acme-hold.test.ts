// Let's Encrypt waits for DNS (modules/domains/acme-hold.ts): a custom
// domain's route asks for a certificate only once a check has seen the
// domain reach a node of the service. Before, every domain's route asked
// at once, so a record still pointing elsewhere (behind Cloudflare's
// proxy too) burned Let's Encrypt's 5 failed validations per host an hour.
// Held: plain HTTP, no redirect, waitingForDns in domains.list. Released
// for good by the first check that proves it, which sends the desired
// state again at once; never held: automatic domains, HTTPS custom and
// off, a domain that had a certificate, and DNS unknown.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { domains as domainOps } from "@seylo/ops";
import { HttpsMode, RouteState } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { alerts, domains, nodes } from "../src/db/schema";
import { serviceNetworking } from "../src/modules/domains/desired";
import { type DnsLookups, setDnsLookups } from "../src/modules/domains/dns";
import { type OriginFetch, originCapability, originPath, originSignedBytes, setOriginFetch } from "../src/modules/domains/origin";
import { applyRouteStatus } from "../src/modules/domains/tracking";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { type FakeAgent, fakeAgent, seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
let agents: FakeAgent[] = [];

beforeEach(async () => {
  panel = testPanel();
  cookie = (await createUser(panel, "owner")).cookie;
});
afterEach(() => {
  for (const agent of agents) agent.disconnect();
  agents = [];
  setDnsLookups(null);
  setOriginFetch(null);
  panel.close();
});

const nodeIp = "203.0.113.10";

/** Public DNS: A records by name, and example.com on Cloudflare's name servers. */
function dns(a: Record<string, string[]>): DnsLookups {
  return {
    resolve4: async (name) => a[name] ?? [],
    resolve6: async () => [],
    resolveCname: async () => [],
    resolveNs: async (name) => (name === "example.com" ? ["ada.ns.cloudflare.com"] : []),
  };
}

function nodeKey(): { publicKey: Buffer; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url"), privateKey };
}

const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });

/** The node's edge answering the origin check. */
const proof =
  (key: KeyObject): OriginFetch =>
  async (url) => {
    const u = new URL(url);
    return text(`${sign(null, originSignedBytes(u.hostname, u.pathname.slice(originPath.length)), key).toString("base64url")}\n`);
  };

/**
 * A service on one node whose agent is connected and answers origin checks
 * (capable: false for an older agent), with the domain's route reported.
 */
function setup(options: { capable?: boolean } = {}) {
  const key = nodeKey();
  const project = seedProject(panel);
  const node = seedNode(panel, { name: "de-fsn-1", ipv4: nodeIp });
  panel.deps.db.update(nodes).set({ publicKey: key.publicKey }).where(eq(nodes.id, node.id)).run();
  const service = seedService(panel, { projectId: project.id, name: "web", ports: [3000], nodeIds: [node.id] });
  const agent = fakeAgent(panel, node.id, {}, ["getNodeFacts"], options.capable === false ? [] : [originCapability]);
  agents.push(agent);
  setOriginFetch(() => Promise.reject(new Error("no network in tests")));
  // The node has every domain's route (pending: these reports say nothing about certificates).
  const routed: string[] = [];
  const add = async (host: string, extra: Record<string, unknown> = {}) => {
    const added = await callOp(panel, domainOps.add, { serviceId: service.id, host, ...extra }, { cookie });
    expect(added.status).toBe(200);
    const domainId: string = added.body.domain.id;
    routed.push(domainId);
    agent.snapshot({
      epoch: 1n,
      services: [{ serviceId: service.id, routes: routed.map((routeId) => ({ routeId, state: RouteState.CERTIFICATE_PENDING })) }],
    });
    return { domainId, ref: { serviceId: service.id, domainId } };
  };
  const route = (domainId: string) => serviceNetworking(panel.deps, service.id, node.id).routing.routes?.find((r) => r.id === domainId);
  const listed = async (domainId: string) =>
    (
      (await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie })).body.domains as {
        id: string;
        certificate: Record<string, unknown>;
      }[]
    ).find((d) => d.id === domainId);
  const dirty = () => panel.deps.agents.desired.takeDirty();
  return { key, node, service, agent, add, route, listed, dirty };
}

const plainHttp = { https: HttpsMode.OFF, redirectToHttps: false };
const acme = { https: HttpsMode.ACME, redirectToHttps: true };

describe("a domain whose DNS does not reach the node yet", () => {
  test("no record: plain HTTP and waitingForDns, until a check finds the record on the node", async () => {
    const s = setup();
    setDnsLookups(dns({}));
    const { domainId, ref } = await s.add("shop.example.com");
    expect(s.route(domainId)).toMatchObject(plainHttp);
    expect((await s.listed(domainId))?.certificate).toMatchObject({ status: "pending", waitingForDns: true });

    // Still no record: nothing changes, nothing is sent.
    s.dirty();
    await callOp(panel, domainOps.checkDns, ref, { cookie });
    expect(s.dirty()).toEqual([]);
    expect(s.route(domainId)).toMatchObject(plainHttp);

    // The record is there: the route asks Let's Encrypt, and the node gets it right away.
    setDnsLookups(dns({ "shop.example.com": [nodeIp] }));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.status).toBe("ok");
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject(acme);
    const released = await s.listed(domainId);
    expect(released?.certificate.status).toBe("pending");
    expect(released?.certificate.waitingForDns).toBeUndefined();

    // Released for good: a record that moves away later does not take HTTPS back.
    setDnsLookups(dns({ "shop.example.com": ["198.51.100.1"] }));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.status).toBe("wrongTarget");
    expect(s.dirty()).toEqual([]);
    expect(s.route(domainId)).toMatchObject(acme);
  });

  test("behind Cloudflare's proxy: held while the origin check is unknown or elsewhere, released by the node's proof", async () => {
    const s = setup();
    setDnsLookups(dns({ "shop.example.com": ["104.16.1.1"] }));
    const { domainId, ref } = await s.add("shop.example.com");
    expect(s.route(domainId)).toMatchObject(plainHttp);
    expect((await s.listed(domainId))?.certificate.waitingForDns).toBe(true);

    // Cloudflare cannot reach an origin (52x), then the record there points at the old host.
    setOriginFetch(async () => text("error code: 522", 522));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("unknown");
    setOriginFetch(async () => text("<!doctype html><title>Old host</title>"));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("elsewhere");
    s.dirty();
    expect(s.route(domainId)).toMatchObject(plainHttp);

    // The record in Cloudflare points at the node now.
    setOriginFetch(proof(s.key.privateKey));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("node");
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject(acme);
    expect((await s.listed(domainId))?.certificate.waitingForDns).toBeUndefined();
  });

  test("the origin check a few seconds after domains.add releases it too", async () => {
    const s = setup();
    setDnsLookups(dns({ "shop.example.com": ["104.16.1.1"] }));
    const { domainId } = await s.add("shop.example.com");
    s.dirty();
    setOriginFetch(proof(s.key.privateKey));
    await panel.runner.runDue(panel.deps, new Date(Date.now() + 60_000));
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject(acme);
  });

  test("a record on the node's address with another server answering there is held", async () => {
    const s = setup();
    setDnsLookups(dns({}));
    const { domainId, ref } = await s.add("shop.example.com");
    setDnsLookups(dns({ "shop.example.com": [nodeIp] }));
    setOriginFetch(async () => text("<p>router login</p>"));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body).toMatchObject({ status: "ok", origin: "elsewhere" });
    expect(s.route(domainId)).toMatchObject(plainHttp);
  });

  test("Regenerate certificate checks again: refused while still held, and starts the certificate once proven", async () => {
    const s = setup();
    setDnsLookups(dns({ "shop.example.com": ["104.16.1.1"] }));
    const { domainId, ref } = await s.add("shop.example.com");
    setOriginFetch(async () => text("error code: 522", 522));
    const refused = await callOp(panel, domainOps.retryCertificate, ref, { cookie });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("waitingForDns");
    expect(refused.body.error.message).toContain(nodeIp);

    setOriginFetch(proof(s.key.privateKey));
    s.dirty();
    const started = await callOp(panel, domainOps.retryCertificate, ref, { cookie });
    expect(started.status).toBe(200);
    expect(started.body.certificate).toMatchObject({ status: "pending" });
    expect(started.body.certificate.waitingForDns).toBeUndefined();
    // The desired state starts it: no node had an ACME route to retry.
    expect(s.agent.calls.filter((c) => c.method === "retryCertificate")).toHaveLength(0);
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject(acme);
  });
});

describe("what never waits", () => {
  test("a record on the node, a failed lookup, and a proxied domain nothing can prove", async () => {
    const s = setup({ capable: false });
    setDnsLookups(dns({ "ok.example.com": [nodeIp], "cf.example.com": ["104.16.1.1"] }));
    const ok = await s.add("ok.example.com");
    expect(s.route(ok.domainId)).toMatchObject(acme);
    // The node's agent does not answer origin checks: as before the hold.
    const cf = await s.add("cf.example.com");
    expect(s.route(cf.domainId)).toMatchObject(acme);

    // Unknown (the resolver failed) never holds, so an outage cannot keep a domain off HTTPS.
    setDnsLookups({ ...dns({}), resolve4: () => Promise.reject(new Error("timeout")) });
    const unknown = await s.add("down.example.com");
    expect(panel.deps.db.select().from(domains).where(eq(domains.id, unknown.domainId)).get()?.dnsStatus).toBe("unknown");
    expect(s.route(unknown.domainId)).toMatchObject(acme);
    expect((await s.listed(unknown.domainId))?.certificate.waitingForDns).toBeUndefined();
  });

  test("automatic domains, HTTPS off and custom, redirect-only domains behind the proxy", async () => {
    const s = setup();
    setDnsLookups(dns({ "www.example.com": ["104.16.1.1"] }));
    const auto = await callOp(panel, domainOps.addAuto, { serviceId: s.service.id }, { cookie });
    expect(s.route(auto.body.id)).toMatchObject(acme);
    const off = await s.add("plain.example.com", { https: "off" });
    expect(s.route(off.domainId)).toMatchObject({ https: HttpsMode.OFF });
    expect((await s.listed(off.domainId))?.certificate.waitingForDns).toBeUndefined();
    // A redirect-only domain gets no origin check, so behind the proxy nothing would ever prove it.
    const www = await s.add("www.example.com", { forward: { url: "https://shop.example.com", permanent: true, keepPath: true } });
    expect(s.route(www.domainId)).toMatchObject(acme);
    // Held, then a custom certificate: it serves that at once.
    const custom = await s.add("secure.example.com");
    expect(s.route(custom.domainId)).toMatchObject(plainHttp);
    panel.deps.db.update(domains).set({ https: "custom" }).where(eq(domains.id, custom.domainId)).run();
    expect(s.route(custom.domainId)?.https).not.toBe(HttpsMode.OFF);
  });

  test("a domain that had a certificate keeps HTTPS whatever DNS says now", async () => {
    const s = setup();
    setDnsLookups(dns({}));
    const { domainId } = await s.add("shop.example.com");
    expect(s.route(domainId)).toMatchObject(plainHttp);
    panel.deps.db
      .update(domains)
      .set({ certStatus: "failed", certExpiresAt: new Date(Date.now() + 5 * 86_400_000) })
      .where(eq(domains.id, domainId))
      .run();
    expect(s.route(domainId)).toMatchObject(acme);
  });
});

describe("route reports of a held domain", () => {
  test("serving over plain HTTP is no certificate; a report naming one is, and ends the hold", async () => {
    const s = setup();
    setDnsLookups(dns({}));
    const { domainId } = await s.add("shop.example.com");
    s.dirty();
    applyRouteStatus(panel.deps, { serviceId: s.service.id, routes: [{ routeId: domainId, state: RouteState.ACTIVE }] } as never);
    let row = panel.deps.db.select().from(domains).where(eq(domains.id, domainId)).get();
    expect(row).toMatchObject({ certStatus: "pending", liveAt: null, dnsStatus: "missing" });
    expect(s.dirty()).toEqual([]);

    // A failure of the ACME route from before the hold: no alert, no failed state.
    applyRouteStatus(panel.deps, {
      serviceId: s.service.id,
      routes: [{ routeId: domainId, state: RouteState.CERTIFICATE_FAILED, message: "acme: 403 DNS problem: NXDOMAIN" }],
    } as never);
    expect(panel.deps.db.select().from(alerts).all()).toHaveLength(0);
    expect(panel.deps.db.select().from(domains).where(eq(domains.id, domainId)).get()?.certStatus).toBe("pending");

    // The node holds a certificate after all (its route asked before the hold).
    const expires = Math.floor(Date.now() / 1000) + 90 * 86_400;
    applyRouteStatus(panel.deps, {
      serviceId: s.service.id,
      routes: [{ routeId: domainId, state: RouteState.ACTIVE, certificateExpiresAt: { seconds: BigInt(expires), nanos: 0 } }],
    } as never);
    row = panel.deps.db.select().from(domains).where(eq(domains.id, domainId)).get();
    expect(row?.certStatus).toBe("valid");
    expect(row?.liveAt).not.toBeNull();
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject(acme);
  });

  test("the node's own DNS check saying elsewhere holds a domain nothing proved yet", async () => {
    const s = setup();
    setDnsLookups({ ...dns({}), resolve4: () => Promise.reject(new Error("timeout")) });
    const { domainId } = await s.add("shop.example.com");
    expect(s.route(domainId)).toMatchObject(acme);
    s.dirty();
    applyRouteStatus(panel.deps, {
      serviceId: s.service.id,
      routes: [
        { routeId: domainId, state: RouteState.DNS_MISMATCH, message: "shop.example.com resolves to 198.51.100.1, not to this node" },
      ],
    } as never);
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject(plainHttp);
  });
});
