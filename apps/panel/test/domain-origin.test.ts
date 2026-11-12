// The origin check of custom domains (modules/domains/origin.ts): the
// panel fetches http://<host>/.well-known/seylo-origin/<challenge> and checks
// the answer against the keys of the service's nodes. node, elsewhere and
// unknown, the redirects it follows, the agents it trusts to have answered,
// domains.checkDns and the check a few seconds after domains.add.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { domains as domainOps } from "@seylo/ops";
import { RouteState } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { verifyEd25519 } from "../src/agent-hub/signature";
import { domains, jobs, nodes, servicePlacements } from "../src/db/schema";
import { type DnsLookups, setDnsLookups } from "../src/modules/domains/dns";
import {
  type OriginFetch,
  originCapability,
  originCheckJobType,
  originPath,
  originSignedBytes,
  probeOrigin,
  setOriginFetch,
  vettedFetch,
} from "../src/modules/domains/origin";
import { applyRouteStatus } from "../src/modules/domains/tracking";
import { setTargetResolver } from "../src/modules/uptime/targets";
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
  setTargetResolver(null);
  panel.close();
});

/** The vector of go/internal/edge/origin_test.go: key from seed 0x01..0x20, host shop.example.com. */
const vector = {
  publicKey: "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ",
  challenge: "Zm9yLXRoZS1vcmlnaW4tdGVzdA",
  proof: "jd34eehjI9eUBT_0Dtz4E2IeXTIteq1XT1YdJijGbaUll0tVsAobiz9XcC9V-xZWGPfjwBp14tPFkADxV7qLCQ",
};

function nodeKey(): { publicKey: Buffer; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url"), privateKey };
}

/** What the node's edge answers: the signature over the URL's host and challenge. */
function proofFor(key: KeyObject, url: string): string {
  const u = new URL(url);
  return `${sign(null, originSignedBytes(u.hostname, u.pathname.slice(originPath.length)), key).toString("base64url")}\n`;
}

/** A fetch that answers every request with `answer(url)` and records the URLs. */
function fakeFetch(answer: (url: string) => Response | Promise<Response>): OriginFetch & { urls: string[] } {
  const urls: string[] = [];
  const f = Object.assign(
    async (url: string) => {
      urls.push(url);
      return answer(url);
    },
    { urls },
  );
  return f;
}

const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });

/** An answer of Cloudflare's own, as its edge sends it (cf-ray, server: cloudflare). */
const cloudflare = (status: number, body = `error code: ${status}`) =>
  new Response(body, { status, headers: { "content-type": "text/plain", "cf-ray": "8f1c2a3b4d5e6f70-FRA", server: "cloudflare" } });

/** Always Use HTTPS: http:// gets Cloudflare's redirect to https, and https gets `answer`. */
const alwaysHttps = (answer: (url: string) => Response) =>
  fakeFetch((url) =>
    url.startsWith("http://")
      ? new Response(null, {
          status: 301,
          headers: { location: url.replace("http://", "https://"), "cf-ray": "8f1c2a3b4d5e6f70-FRA", server: "cloudflare" },
        })
      : answer(url),
  );

/** shop.example.com behind Cloudflare's proxy, on a service placed on one node whose agent answers the check. */
async function proxiedDomain(options: { capable?: boolean; routed?: boolean; handlers?: Parameters<typeof fakeAgent>[2] } = {}) {
  const key = nodeKey();
  const project = seedProject(panel);
  const node = seedNode(panel, { name: "de-fsn-1", ipv4: "203.0.113.10" });
  panel.deps.db.update(nodes).set({ publicKey: key.publicKey }).where(eq(nodes.id, node.id)).run();
  const service = seedService(panel, { projectId: project.id, name: "web", ports: [3000], nodeIds: [node.id] });
  const lookups: DnsLookups = {
    resolve4: async (name) => (name === "shop.example.com" ? ["104.16.1.1"] : []),
    resolve6: async () => [],
    resolveCname: async () => [],
    resolveNs: async (name) => (name === "example.com" ? ["ada.ns.cloudflare.com"] : []),
  };
  setDnsLookups(lookups);
  // Until the agent answers, nothing is fetched.
  setOriginFetch(() => Promise.reject(new Error("no network in tests")));
  const added = await callOp(panel, domainOps.add, { serviceId: service.id, host: "shop.example.com" }, { cookie });
  const domainId: string = added.body.domain.id;
  const agent = fakeAgent(panel, node.id, options.handlers ?? {}, ["getNodeFacts"], options.capable === false ? [] : [originCapability]);
  agents.push(agent);
  agent.snapshot({
    epoch: 1n,
    services: [
      { serviceId: service.id, routes: options.routed === false ? [] : [{ routeId: domainId, state: RouteState.CERTIFICATE_PENDING }] },
    ],
  });
  return { key, node, service, agent, domainId, ref: { serviceId: service.id, domainId } };
}

const listed = async (serviceId: string) =>
  (await callOp(panel, domainOps.list, { serviceId }, { cookie })).body.domains as {
    host: string;
    origin?: string;
    originCheckedAt?: string;
    originReason?: string;
  }[];

describe("origin proofs", () => {
  test("the Go agent's vector verifies, for its host and challenge only", () => {
    const pub = Buffer.from(vector.publicKey, "base64url");
    const sig = Buffer.from(vector.proof, "base64url");
    expect(verifyEd25519(pub, originSignedBytes("shop.example.com", vector.challenge), sig)).toBe(true);
    expect(verifyEd25519(pub, originSignedBytes("www.example.com", vector.challenge), sig)).toBe(false);
    expect(verifyEd25519(pub, originSignedBytes("shop.example.com", `${vector.challenge}x`), sig)).toBe(false);
    expect(new TextDecoder().decode(originSignedBytes("a.example.com", "c"))).toBe("seylo-origin-v1\0a.example.com\0c");
    expect(originPath).toBe("/.well-known/seylo-origin/");
  });

  test("probeOrigin: a proof, another answer, no answer, and which redirects it follows", async () => {
    const key = nodeKey();
    const keys = [{ id: "n1", publicKey: key.publicKey }];
    const fetcher = fakeFetch((url) => text(proofFor(key.privateKey, url)));
    expect(await probeOrigin("shop.example.com", keys, fetcher)).toEqual({ kind: "proof", nodeId: "n1" });
    // A fresh url-safe challenge of 32 characters every time, on plain HTTP.
    expect(fetcher.urls[0]).toMatch(/^http:\/\/shop\.example\.com\/\.well-known\/seylo-origin\/[A-Za-z0-9_-]{32}$/);
    await probeOrigin("shop.example.com", keys, fetcher);
    expect(fetcher.urls[1]).not.toBe(fetcher.urls[0]);

    // Another node's key, a page of the app, a 404.
    const other = nodeKey();
    expect(
      await probeOrigin(
        "shop.example.com",
        keys,
        fakeFetch((url) => text(proofFor(other.privateKey, url))),
      ),
    ).toEqual({ kind: "other" });
    expect(
      await probeOrigin(
        "shop.example.com",
        keys,
        fakeFetch(() => text("<!doctype html><p>shop</p>")),
      ),
    ).toEqual({ kind: "other" });
    expect(
      await probeOrigin(
        "shop.example.com",
        keys,
        fakeFetch(() => text("404 page not found", 404)),
      ),
    ).toEqual({ kind: "other" });
    // Cloudflare's 52x, a network error, a timeout: no answer.
    expect(
      await probeOrigin(
        "shop.example.com",
        keys,
        fakeFetch(() => text("error code: 522", 522)),
      ),
    ).toEqual({ kind: "none" });
    expect(
      await probeOrigin(
        "shop.example.com",
        keys,
        fakeFetch(() => Promise.reject(new TypeError("connect ECONNREFUSED"))),
      ),
    ).toEqual({
      kind: "none",
    });

    // Always Use HTTPS: http -> https on the same host and path is followed.
    const redirecting = fakeFetch((url) =>
      url.startsWith("http://")
        ? new Response(null, { status: 301, headers: { location: url.replace("http://", "https://") } })
        : text(proofFor(key.privateKey, url)),
    );
    expect(await probeOrigin("shop.example.com", keys, redirecting)).toEqual({ kind: "proof", nodeId: "n1" });
    expect(redirecting.urls[1]).toStartWith("https://shop.example.com/.well-known/seylo-origin/");
    // To another host, another port or another path: that is not this domain answering.
    for (const to of [
      "https://www.example.com/.well-known/seylo-origin/x",
      "https://shop.example.com:8443/",
      "https://shop.example.com/",
    ]) {
      const away = fakeFetch((url) =>
        url.startsWith("http://") ? new Response(null, { status: 302, headers: { location: to } }) : text(proofFor(key.privateKey, url)),
      );
      expect(await probeOrigin("shop.example.com", keys, away)).toEqual({ kind: "none" });
    }
    // A redirect loop ends after 3 hops.
    const loop = fakeFetch((url) => new Response(null, { status: 307, headers: { location: url } }));
    expect(await probeOrigin("shop.example.com", keys, loop)).toEqual({ kind: "none" });
    expect(loop.urls).toHaveLength(4);
  });

  test("probeOrigin: why Cloudflare's own answers did not reach the node", async () => {
    const keys = [{ id: "n1", publicKey: nodeKey().publicKey }];
    const probe = (answer: (url: string) => Response) => probeOrigin("shop.example.com", keys, alwaysHttps(answer));
    // SSL/TLS Full (strict) refuses the node's temporary certificate over Always Use HTTPS' redirect.
    expect(await probe(() => cloudflare(526))).toEqual({ kind: "none", reason: "cloudflareCertificate" });
    expect(await probe(() => cloudflare(525))).toEqual({ kind: "none", reason: "cloudflareCertificate" });
    // Cloudflare cannot connect to the node.
    expect(await probe(() => cloudflare(521))).toEqual({ kind: "none", reason: "cloudflareUnreachable" });
    expect(await probe(() => cloudflare(522))).toEqual({ kind: "none", reason: "cloudflareUnreachable" });
    // A server behind Cloudflare with nothing for the check.
    expect(await probe(() => cloudflare(404, "404 page not found"))).toEqual({ kind: "other", reason: "notFound" });
    // Cloudflare's other errors, and the same codes from a server that is not Cloudflare, say no more than before.
    expect(await probe(() => cloudflare(524))).toEqual({ kind: "none" });
    expect(await probe(() => cloudflare(503))).toEqual({ kind: "none" });
    expect(await probe(() => text("error code: 526", 526))).toEqual({ kind: "none" });
    expect(await probe(() => text("404 page not found", 404))).toEqual({ kind: "other" });
    // Cloudflare's server header alone counts too.
    expect(
      await probeOrigin(
        "shop.example.com",
        keys,
        fakeFetch(() => new Response("error code: 526", { status: 526, headers: { server: "cloudflare" } })),
      ),
    ).toEqual({ kind: "none", reason: "cloudflareCertificate" });
  });

  test("probeOrigin over a real connection: Bun's fetch hands the redirect over, then the proof", async () => {
    const key = nodeKey();
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        hits++;
        const url = new URL(request.url);
        if (hits === 1) return new Response(null, { status: 301, headers: { location: `https://shop.example.com${url.pathname}` } });
        return text(proofFor(key.privateKey, `http://shop.example.com${url.pathname}`));
      },
    });
    try {
      // Both hops reach the local server in place of the domain.
      const local: OriginFetch = (url, init) =>
        fetch(url.replace(/^https?:\/\/shop\.example\.com/, `http://127.0.0.1:${server.port}`), init);
      expect(await probeOrigin("shop.example.com", [{ id: "n1", publicKey: key.publicKey }], local)).toEqual({
        kind: "proof",
        nodeId: "n1",
      });
      expect(hits).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});

describe("where the check connects", () => {
  const init = () => ({ signal: AbortSignal.timeout(2000), redirect: "manual" as const, headers: { accept: "text/plain" } });

  test("a name that resolves into the panel's network gets no request", async () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "fd00::1"]) {
      setTargetResolver(async () => [address]);
      await expect(vettedFetch(panel.deps)("http://shop.example.com/.well-known/seylo-origin/x", init())).rejects.toThrow(
        /origin check refused/,
      );
    }
    // Through domains.checkDns with the real fetch: no answer, so unknown.
    const { ref } = await proxiedDomain();
    setOriginFetch(null);
    setTargetResolver(async () => ["10.0.0.5"]);
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("unknown");
  });

  test("a node's own address is allowed, and the request goes to the vetted address with the domain as Host", async () => {
    let host = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        host = request.headers.get("host") ?? "";
        return text("ok");
      },
    });
    try {
      const node = seedNode(panel, { name: "lan-1" });
      panel.deps.db.update(nodes).set({ publicAddress: "127.0.0.1" }).where(eq(nodes.id, node.id)).run();
      let asked = 0;
      setTargetResolver(async () => {
        asked++;
        return ["127.0.0.1"];
      });
      const response = await vettedFetch(panel.deps)(`http://shop.example.com:${server.port}/.well-known/seylo-origin/x`, init());
      expect(await response.text()).toBe("ok");
      expect(host).toBe(`shop.example.com:${server.port}`);
      expect(asked).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("domains.retryCertificate and the origin", () => {
  test("refused while something else answers behind the proxy, allowed once the node proves itself", async () => {
    const { key, ref } = await proxiedDomain({
      handlers: {
        retryCertificate: (request: { serviceId: string; routeId: string }) => ({
          status: { routeId: request.routeId, state: RouteState.CERTIFICATE_PENDING, message: "waiting" },
          hosts: ["shop.example.com"],
        }),
      },
    });
    setOriginFetch(fakeFetch(() => text("<!doctype html><title>Old host</title>")));
    const refused = await callOp(panel, domainOps.retryCertificate, ref, { cookie });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("originElsewhere");
    expect(refused.body.error.message).toContain("203.0.113.10");
    setOriginFetch(fakeFetch((url) => text(proofFor(key.privateKey, url))));
    const retried = await callOp(panel, domainOps.retryCertificate, ref, { cookie });
    expect(retried.status).toBe(200);
  });
});

describe("domains.checkDns and the origin", () => {
  test("a node of the service answers: node, stored and listed", async () => {
    const { key, service, ref } = await proxiedDomain();
    const fetcher = fakeFetch((url) => text(proofFor(key.privateKey, url)));
    setOriginFetch(fetcher);
    const checked = await callOp(panel, domainOps.checkDns, ref, { cookie });
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ status: "proxied", origin: "node" });
    expect(fetcher.urls).toHaveLength(1);
    const [row] = await listed(service.id);
    expect(row).toMatchObject({ host: "shop.example.com", origin: "node" });
    expect(Date.parse(row?.originCheckedAt ?? "")).toBeGreaterThan(Date.now() - 60_000);
  });

  test("something else answers while the node would have proven itself: elsewhere", async () => {
    const { service, ref } = await proxiedDomain();
    setOriginFetch(fakeFetch(() => text("<!doctype html><title>Old host</title>")));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("elsewhere");
    expect((await listed(service.id))[0]?.origin).toBe("elsewhere");
    // The certificate came after all (the record was fixed): the old answer goes.
    panel.deps.db.update(domains).set({ certStatus: "pending" }).where(eq(domains.id, ref.domainId)).run();
    applyRouteStatus(panel.deps, { serviceId: service.id, routes: [{ routeId: ref.domainId, state: RouteState.ACTIVE }] } as never);
    expect((await listed(service.id))[0]?.origin).toBeUndefined();
  });

  test("behind Cloudflare it says why the check did not reach the node, and a proof clears it", async () => {
    const { key, service, ref } = await proxiedDomain();
    const check = async () => (await callOp(panel, domainOps.checkDns, ref, { cookie })).body;
    const row = async () => (await listed(service.id))[0];

    // SSL/TLS Full (strict) with Always Use HTTPS: 526, or 525.
    setOriginFetch(alwaysHttps(() => cloudflare(526)));
    expect(await check()).toMatchObject({ status: "proxied", origin: "unknown", originReason: "cloudflareCertificate" });
    expect(await row()).toMatchObject({ origin: "unknown", originReason: "cloudflareCertificate" });
    setOriginFetch(alwaysHttps(() => cloudflare(525)));
    expect((await check()).originReason).toBe("cloudflareCertificate");

    // Cloudflare cannot connect to the node: 521, or 522.
    setOriginFetch(alwaysHttps(() => cloudflare(521)));
    expect(await check()).toMatchObject({ origin: "unknown", originReason: "cloudflareUnreachable" });
    setOriginFetch(alwaysHttps(() => cloudflare(522)));
    expect(await check()).toMatchObject({ origin: "unknown", originReason: "cloudflareUnreachable" });
    expect((await row())?.originReason).toBe("cloudflareUnreachable");

    // A 404 through Cloudflare while the node has the route: another server answers.
    setOriginFetch(alwaysHttps(() => cloudflare(404, "404 page not found\n")));
    expect(await check()).toMatchObject({ origin: "elsewhere", originReason: "notFound" });
    expect(await row()).toMatchObject({ origin: "elsewhere", originReason: "notFound" });

    // No answer at all says nothing: the reason goes with the answer it came with.
    setOriginFetch(() => Promise.reject(new TypeError("timed out")));
    const timedOut = await check();
    expect(timedOut.origin).toBe("unknown");
    expect(timedOut.originReason).toBeUndefined();
    expect((await row())?.originReason).toBeUndefined();

    // The node proves itself over https: no reason.
    setOriginFetch(alwaysHttps(() => cloudflare(526)));
    await check();
    setOriginFetch(alwaysHttps((url) => text(proofFor(key.privateKey, url))));
    const proven = await check();
    expect(proven.origin).toBe("node");
    expect(proven.originReason).toBeUndefined();
    expect(await row()).toMatchObject({ origin: "node" });
    expect((await row())?.originReason).toBeUndefined();
  });

  test("the reason without an origin to go with it is not listed", async () => {
    const { service, ref } = await proxiedDomain();
    setOriginFetch(alwaysHttps(() => cloudflare(526)));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.originReason).toBe("cloudflareCertificate");
    // The record moved: DNS missing clears the origin, and the reason with it.
    setDnsLookups({ resolve4: async () => [], resolve6: async () => [], resolveCname: async () => [], resolveNs: async () => [] });
    const missing = await callOp(panel, domainOps.checkDns, ref, { cookie });
    expect(missing.body.originReason).toBeUndefined();
    const [row] = await listed(service.id);
    expect(row?.origin).toBeUndefined();
    expect(row?.originReason).toBeUndefined();
  });

  test("an agent that does not answer the check yet: unknown, without a request", async () => {
    const { ref } = await proxiedDomain({ capable: false });
    const fetcher = fakeFetch(() => text("<p>app</p>"));
    setOriginFetch(fetcher);
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("unknown");
    expect(fetcher.urls).toHaveLength(0);
  });

  test("a node without the domain's route yet: unknown, not elsewhere", async () => {
    const { ref } = await proxiedDomain({ routed: false });
    setOriginFetch(fakeFetch(() => text("404 page not found", 404)));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("unknown");
  });

  test("a second node with an older agent may have answered: unknown, while a proof from the updated one still counts", async () => {
    const { key, service, ref } = await proxiedDomain();
    const old = seedNode(panel, { name: "de-fsn-2", ipv4: "203.0.113.11" });
    panel.deps.db.insert(servicePlacements).values({ serviceId: service.id, nodeId: old.id }).run();
    setOriginFetch(fakeFetch(() => text("<p>app</p>")));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("unknown");
    setOriginFetch(fakeFetch((url) => text(proofFor(key.privateKey, url))));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("node");
  });

  test("a record that moved (DNS missing) drops the old answer", async () => {
    const { key, service, ref } = await proxiedDomain();
    setOriginFetch(fakeFetch((url) => text(proofFor(key.privateKey, url))));
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.origin).toBe("node");
    setDnsLookups({ resolve4: async () => [], resolve6: async () => [], resolveCname: async () => [], resolveNs: async () => [] });
    const missing = await callOp(panel, domainOps.checkDns, ref, { cookie });
    expect(missing.body.status).toBe("missing");
    expect(missing.body.origin).toBeUndefined();
    expect((await listed(service.id))[0]?.origin).toBeUndefined();
    expect(panel.deps.db.select().from(domains).where(eq(domains.id, ref.domainId)).get()?.originStatus).toBeNull();
  });

  test("redirect-only and automatic domains are not checked", async () => {
    const { key, service } = await proxiedDomain();
    const fetcher = fakeFetch((url) => text(proofFor(key.privateKey, url)));
    setOriginFetch(fetcher);
    const www = await callOp(
      panel,
      domainOps.add,
      { serviceId: service.id, host: "www.example.com", forward: { url: "https://shop.example.com", permanent: true, keepPath: true } },
      { cookie },
    );
    expect(
      (await callOp(panel, domainOps.checkDns, { serviceId: service.id, domainId: www.body.domain.id }, { cookie })).body.origin,
    ).toBeUndefined();
    const auto = await callOp(panel, domainOps.addAuto, { serviceId: service.id }, { cookie });
    expect(
      (await callOp(panel, domainOps.checkDns, { serviceId: service.id, domainId: auto.body.id }, { cookie })).body.origin,
    ).toBeUndefined();
    expect(fetcher.urls).toHaveLength(0);
  });
});

describe("the check after domains.add", () => {
  const due = () => panel.runner.runDue(panel.deps, new Date(Date.now() + 60_000));
  const queued = () => panel.deps.db.select().from(jobs).all();

  test("runs once the node has the route, and stores the answer", async () => {
    const { key, service } = await proxiedDomain();
    expect(queued().filter((j) => j.type === originCheckJobType && j.status === "queued")).toHaveLength(1);
    setOriginFetch(fakeFetch((url) => text(proofFor(key.privateKey, url))));
    await due();
    expect((await listed(service.id))[0]?.origin).toBe("node");
  });

  test("waits while the node has not reported the route, then answers", async () => {
    const { key, service, agent, domainId } = await proxiedDomain({ routed: false });
    const fetcher = fakeFetch(() => text("404 page not found", 404));
    setOriginFetch(fetcher);
    await due();
    // Not stored: whatever answered before the route is there proves nothing.
    expect((await listed(service.id))[0]?.origin).toBeUndefined();
    expect(queued().filter((j) => j.type === originCheckJobType && j.status === "queued")).toHaveLength(1);
    agent.snapshot({
      epoch: 2n,
      services: [{ serviceId: service.id, routes: [{ routeId: domainId, state: RouteState.CERTIFICATE_PENDING }] }],
    });
    setOriginFetch(fakeFetch((url) => text(proofFor(key.privateKey, url))));
    await due();
    expect((await listed(service.id))[0]?.origin).toBe("node");
  });

  test("stores why Cloudflare did not bring it to the node", async () => {
    const { service } = await proxiedDomain();
    setOriginFetch(alwaysHttps(() => cloudflare(526)));
    await due();
    expect((await listed(service.id))[0]).toMatchObject({ origin: "unknown", originReason: "cloudflareCertificate" });
  });

  test("a domain still waiting for DNS is not checked", async () => {
    const project = seedProject(panel);
    const node = seedNode(panel);
    const service = seedService(panel, { projectId: project.id, name: "api", ports: [3000], nodeIds: [node.id] });
    setDnsLookups({ resolve4: async () => [], resolve6: async () => [], resolveCname: async () => [], resolveNs: async () => [] });
    await callOp(panel, domainOps.add, { serviceId: service.id, host: "api.example.com" }, { cookie });
    expect(queued().filter((j) => j.type === originCheckJobType)).toHaveLength(0);
  });
});
