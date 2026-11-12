// Let's Encrypt waits for DNS (modules/domains/acme-hold.ts): a custom
// domain's route asks for a certificate only once a check has seen the
// domain reach a node of the service. Before, every domain's route asked
// at once, so a record still pointing elsewhere (behind Cloudflare's
// proxy too) burned Let's Encrypt's 5 failed validations per host an hour.
// Held: no certificate resolver, no redirect, waitingForDns in domains.list. Released
// for good by the first check that proves it, which sends the desired
// state again at once; never held: automatic domains, HTTPS custom and
// off, a domain that had a certificate, and DNS unknown. A waiting domain
// is checked again on its own (recheck.ts), so nobody has to look.

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { domains as domainOps } from "@seylo/ops";
import { HttpsMode, RouteState } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { alerts, domains, nodes } from "../src/db/schema";
import type { JobContext } from "../src/jobs/queue";
import { serviceNetworking } from "../src/modules/domains/desired";
import { type DnsLookups, setDnsLookups } from "../src/modules/domains/dns";
import { type OriginFetch, originCapability, originPath, originSignedBytes, setOriginFetch } from "../src/modules/domains/origin";
import { recheckEveryMs, recheckJob } from "../src/modules/domains/recheck";
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
  setSystemTime();
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
  const service = seedService(panel, { projectId: project.id, name: "web", ports: [3000], nodeIds: [node.id], deployed: true });
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

/**
 * Held: ACME without asking the CA (Route.acme_hold), so the node serves
 * plain HTTP without the redirect and HTTPS with Traefik's default
 * certificate, and the origin check reaches it on either port. Before it
 * went out as HTTPS off, so behind Cloudflare with Always Use HTTPS on the
 * check met Traefik's 404 on 443 ("elsewhere") and the hold never ended.
 */
const held = { https: HttpsMode.ACME, acmeHold: true, redirectToHttps: false };
const acme = { https: HttpsMode.ACME, acmeHold: false, redirectToHttps: true };

describe("a domain whose DNS does not reach the node yet", () => {
  test("no record: plain HTTP and waitingForDns, until a check finds the record on the node", async () => {
    const s = setup();
    setDnsLookups(dns({}));
    const { domainId, ref } = await s.add("shop.example.com");
    expect(s.route(domainId)).toMatchObject(held);
    expect((await s.listed(domainId))?.certificate).toMatchObject({ status: "pending", waitingForDns: true });

    // Still no record: nothing changes, nothing is sent.
    s.dirty();
    await callOp(panel, domainOps.checkDns, ref, { cookie });
    expect(s.dirty()).toEqual([]);
    expect(s.route(domainId)).toMatchObject(held);

    // The record is there: the route asks Let's Encrypt, and the node gets it right away.
    setDnsLookups(dns({ "shop.example.com": [nodeIp] }));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.status).toBe("ok");
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject(acme);
    const released = await s.listed(domainId);
    expect(released?.certificate.status).toBe("pending");
    expect(released?.certificate.waitingForDns).toBeUndefined();

    // Released for good: a record that moves away later does not take HTTPS back. The route answers
    // Let's Encrypt's challenge on 443 now, since the record no longer goes straight to the node.
    setDnsLookups(dns({ "shop.example.com": ["198.51.100.1"] }));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.status).toBe("wrongTarget");
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject({ ...acme, acmeChallengeOnHttps: true });
  });

  test("behind Cloudflare's proxy: held while the origin check is unknown or elsewhere, released by the node's proof", async () => {
    const s = setup();
    setDnsLookups(dns({ "shop.example.com": ["104.16.1.1"] }));
    const { domainId, ref } = await s.add("shop.example.com");
    expect(s.route(domainId)).toMatchObject(held);
    expect((await s.listed(domainId))?.certificate.waitingForDns).toBe(true);

    // Cloudflare cannot reach an origin (52x), then the record there points at the old host.
    setOriginFetch(async () => text("error code: 522", 522));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("unknown");
    setOriginFetch(async () => text("<!doctype html><title>Old host</title>"));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("elsewhere");
    s.dirty();
    expect(s.route(domainId)).toMatchObject(held);

    // The record in Cloudflare points at the node now.
    setOriginFetch(proof(s.key.privateKey));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("node");
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject(acme);
    expect((await s.listed(domainId))?.certificate.waitingForDns).toBeUndefined();
  });

  test("behind Cloudflare with Always Use HTTPS on: the check reaches the held route on 443 and releases it", async () => {
    const s = setup();
    setDnsLookups(dns({ "shop.example.com": ["104.16.1.1"] }));
    const { domainId, ref } = await s.add("shop.example.com");
    expect(s.route(domainId)).toMatchObject(held);
    // Cloudflare redirects http:// to https:// and (SSL/TLS Full) connects to the node on 443, where Traefik
    // answers the origin path only for a route with HTTPS routers (go/internal/proxy addOrigin); HTTPS off has
    // none there, so Traefik's 404 read as another server and the hold never ended.
    setOriginFetch(async (url, init) => {
      if (url.startsWith("http://")) return new Response(null, { status: 301, headers: { location: url.replace("http://", "https://") } });
      if (s.route(domainId)?.https === HttpsMode.OFF) return text("404 page not found\n", 404);
      return proof(s.key.privateKey)(url, init);
    });
    s.dirty();
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("node");
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject(acme);
  });

  test("behind Cloudflare with SSL/TLS Full (strict): held, and the row says why, until the node proves itself", async () => {
    const s = setup();
    setDnsLookups(dns({ "shop.example.com": ["104.16.1.1"] }));
    const { domainId, ref } = await s.add("shop.example.com");
    const cf = { "cf-ray": "8f1c2a3b4d5e6f70-FRA", server: "cloudflare" };
    // Always Use HTTPS redirects the check to https; Full (strict) refuses Traefik's default certificate there.
    let strict = true;
    setOriginFetch(async (url, init) => {
      if (url.startsWith("http://"))
        return new Response(null, { status: 301, headers: { location: url.replace("http://", "https://"), ...cf } });
      if (strict) return new Response("error code: 526", { status: 526, headers: cf });
      return proof(s.key.privateKey)(url, init);
    });
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body).toMatchObject({
      origin: "unknown",
      originReason: "cloudflareCertificate",
    });
    expect(s.route(domainId)).toMatchObject(held);
    expect(await s.listed(domainId)).toMatchObject({ originReason: "cloudflareCertificate", certificate: { waitingForDns: true } });

    // SSL/TLS set to Full: the check passes over https and the certificate starts.
    strict = false;
    s.dirty();
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("node");
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject(acme);
    const released = await s.listed(domainId);
    expect(released).not.toHaveProperty("originReason");
    expect(released?.certificate.waitingForDns).toBeUndefined();
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
    expect(s.route(domainId)).toMatchObject(held);
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
    expect(s.route(custom.domainId)).toMatchObject(held);
    panel.deps.db.update(domains).set({ https: "custom" }).where(eq(domains.id, custom.domainId)).run();
    expect(s.route(custom.domainId)).toMatchObject({ acmeHold: false, redirectToHttps: true });
  });

  test("a domain that had a certificate keeps HTTPS whatever DNS says now", async () => {
    const s = setup();
    setDnsLookups(dns({}));
    const { domainId } = await s.add("shop.example.com");
    expect(s.route(domainId)).toMatchObject(held);
    panel.deps.db
      .update(domains)
      .set({ certStatus: "failed", certExpiresAt: new Date(Date.now() + 5 * 86_400_000) })
      .where(eq(domains.id, domainId))
      .run();
    expect(s.route(domainId)).toMatchObject(acme);
  });
});

/**
 * Let's Encrypt's challenge on 443 (Route.acme_challenge_on_https, 0.2.12):
 * behind Cloudflare's proxy with a redirect to https for every path (a
 * Redirect Rule or Page Rule) the CA's http:// request is redirected to
 * https and reaches the node on 443, so the route answers it there too, for
 * the first certificate and every renewal. A domain whose
 * record points straight at the node does not need it (the CA reaches port
 * 80, where Traefik answers), and its app keeps the path over https:
 * Traefik's handler answers only its own tokens and never falls through,
 * so an app answering challenges itself there would lose them. Before,
 * every ACME route took the path on 443.
 */
describe("Let's Encrypt's challenge on 443", () => {
  test("unless the record points straight at the node, held or released", async () => {
    const s = setup();
    setDnsLookups(dns({ "ok.example.com": [nodeIp], "cf.example.com": ["104.16.1.1"] }));
    // Straight to the node.
    const direct = await s.add("ok.example.com");
    expect(s.route(direct.domainId)).toMatchObject({ ...acme, acmeChallengeOnHttps: false });
    // Behind the proxy, held and then released by the node's proof: the renewals need it as much.
    const proxied = await s.add("cf.example.com");
    expect(s.route(proxied.domainId)).toMatchObject({ ...held, acmeChallengeOnHttps: true });
    setOriginFetch(proof(s.key.privateKey));
    expect((await callOp(panel, domainOps.checkDns, proxied.ref, { cookie })).body.origin).toBe("node");
    expect(s.route(proxied.domainId)).toMatchObject({ ...acme, acmeChallengeOnHttps: true });
    // No record yet, and a lookup that failed: nothing says the record goes straight to the node.
    expect(s.route((await s.add("new.example.com")).domainId)).toMatchObject({ acmeChallengeOnHttps: true });
    setDnsLookups({ ...dns({}), resolve4: () => Promise.reject(new Error("timeout")) });
    expect(s.route((await s.add("down.example.com")).domainId)).toMatchObject({ ...acme, acmeChallengeOnHttps: true });
    // Automatic domains are on the node's wildcard record, which nothing checks.
    const auto = await callOp(panel, domainOps.addAuto, { serviceId: s.service.id }, { cookie });
    expect(s.route(auto.body.id)).toMatchObject({ ...acme, acmeChallengeOnHttps: true });
    // Without Let's Encrypt there is no challenge.
    const off = await s.add("plain.example.com", { https: "off" });
    expect(s.route(off.domainId)).toMatchObject({ https: HttpsMode.OFF, acmeChallengeOnHttps: false });
  });

  test("a check that moves the record behind the proxy or back sends the route again", async () => {
    const s = setup();
    setDnsLookups(dns({ "shop.example.com": [nodeIp] }));
    const { domainId, ref } = await s.add("shop.example.com");
    expect(s.route(domainId)).toMatchObject({ ...acme, acmeChallengeOnHttps: false });
    s.dirty();
    // Nothing changed: nothing is sent.
    await callOp(panel, domainOps.checkDns, ref, { cookie });
    expect(s.dirty()).toEqual([]);
    // The owner turned on Cloudflare's proxy for the record (released already, so no hold).
    setDnsLookups(dns({ "shop.example.com": ["104.16.1.1"] }));
    setOriginFetch(proof(s.key.privateKey));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.status).toBe("proxied");
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject({ ...acme, acmeChallengeOnHttps: true });
    // And off again.
    setDnsLookups(dns({ "shop.example.com": [nodeIp] }));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.status).toBe("ok");
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject({ ...acme, acmeChallengeOnHttps: false });
  });
});

describe("the re-check of waiting domains", () => {
  const run = () => recheckJob.run({}, panel.deps as JobContext);

  test("a record fixed with nobody looking starts the certificate at the next check that is due", async () => {
    const s = setup();
    let lookups = 0;
    const counted = (a: Record<string, string[]>): DnsLookups => ({
      ...dns(a),
      resolve4: async (name) => {
        lookups++;
        return a[name] ?? [];
      },
    });
    setDnsLookups(counted({}));
    const { domainId } = await s.add("shop.example.com");
    setDnsLookups(counted({ "shop.example.com": [nodeIp] }));
    lookups = 0;
    s.dirty();
    // Checked a moment ago by domains.add: not due yet.
    await run();
    expect(lookups).toBe(0);
    expect(s.route(domainId)).toMatchObject(held);

    setSystemTime(new Date(Date.now() + 3 * 60_000));
    await run();
    expect(lookups).toBe(1);
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject(acme);
    // Released: never checked again by the job.
    setSystemTime(new Date(Date.now() + 60 * 60_000));
    await run();
    expect(lookups).toBe(1);
  });

  test("a failed lookup keeps the last answer: the hold stays and the domain is checked again", async () => {
    const s = setup();
    let lookups = 0;
    const failing: DnsLookups = {
      ...dns({}),
      resolve4: () => {
        lookups++;
        return Promise.reject(new Error("timeout"));
      },
    };
    setDnsLookups(dns({}));
    const { domainId, ref } = await s.add("shop.example.com");
    const row = () => panel.deps.db.select().from(domains).where(eq(domains.id, domainId)).get();
    s.dirty();

    // The public resolver times out at the next due check: no record is still the last word.
    setDnsLookups(failing);
    setSystemTime(new Date(Date.now() + 3 * 60_000));
    await run();
    expect(lookups).toBe(1);
    expect(row()?.dnsStatus).toBe("missing");
    expect(s.dirty()).toEqual([]);
    expect(s.route(domainId)).toMatchObject(held);
    expect((await s.listed(domainId))?.certificate.waitingForDns).toBe(true);
    // The check counts for the pacing, so an outage is not asked about every minute.
    expect(row()?.dnsCheckedAt?.getTime()).toBe(Date.now());

    // Check now and Regenerate certificate during the outage say the lookup failed and change nothing.
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.status).toBe("unknown");
    const refused = await callOp(panel, domainOps.retryCertificate, ref, { cookie });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("waitingForDns");
    expect(row()?.dnsStatus).toBe("missing");
    expect(s.dirty()).toEqual([]);
    expect(s.route(domainId)).toMatchObject(held);

    // Still a waiting domain for the job: the next good lookup finds the record and starts the certificate.
    setDnsLookups(dns({ "shop.example.com": [nodeIp] }));
    setSystemTime(new Date(Date.now() + 3 * 60_000));
    await run();
    expect(s.dirty()).toEqual([{ serviceId: s.service.id }]);
    expect(s.route(domainId)).toMatchObject(acme);
  });

  test("behind Cloudflare's proxy a failed lookup keeps the origin check's answer too", async () => {
    const s = setup();
    setDnsLookups(dns({ "shop.example.com": ["104.16.1.1"] }));
    const { domainId, ref } = await s.add("shop.example.com");
    setOriginFetch(async () => text("<!doctype html><title>Old host</title>"));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("elsewhere");
    s.dirty();
    setDnsLookups({ ...dns({}), resolve4: () => Promise.reject(new Error("timeout")) });
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.status).toBe("unknown");
    expect(panel.deps.db.select().from(domains).where(eq(domains.id, domainId)).get()).toMatchObject({
      dnsStatus: "proxied",
      originStatus: "elsewhere",
    });
    expect(s.dirty()).toEqual([]);
    expect(s.route(domainId)).toMatchObject(held);
  });

  test("less often the longer a domain waits", () => {
    expect(recheckEveryMs(5 * 60_000)).toBe(2 * 60_000);
    expect(recheckEveryMs(3 * 3_600_000)).toBe(15 * 60_000);
    expect(recheckEveryMs(3 * 86_400_000)).toBe(6 * 3_600_000);
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
    expect(s.route(domainId)).toMatchObject(held);
  });
});
