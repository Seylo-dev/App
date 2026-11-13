// A domain behind Cloudflare's proxy whose origin is not known gets checked
// until it is (0.2.16). On the owner's panel (0.2.15) the apex and www of
// one app were both live with valid certificates, the apex's origin was
// node, and www had none at all: its Domains tab showed a red 1 and the
// page said nothing. Two things left it there. An origin check that began
// before another one finished could store its older answer over the newer
// one, so Traefik's 404 from before it served www's route ("elsewhere")
// replaced the proof that had released the certificate; when the
// certificate came, tracking.ts cleared that "elsewhere" and nothing ever
// checked www again, since only domains whose certificate waits were
// re-checked. Now an older answer is not stored, a cleared "elsewhere" is
// checked again a few seconds later, and recheck.ts checks every origin
// that is not known on the same steps as waiting domains, counted from the
// first unknown answer (origin_unknown_since, which the Domains tab reads).

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { domains as domainOps } from "@seylo/ops";
import { RouteState } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { domains, jobs, nodes } from "../src/db/schema";
import type { JobContext } from "../src/jobs/queue";
import { type DnsLookups, setDnsLookups } from "../src/modules/domains/dns";
import { originCapability, originCheckJobType, originPath, originSignedBytes, setOriginFetch } from "../src/modules/domains/origin";
import { originRecheckDue, recheckJob } from "../src/modules/domains/recheck";
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

const minute = 60_000;
const hour = 60 * minute;

function nodeKey(): { publicKey: Buffer; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url"), privateKey };
}

const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });

/** An answer that came through Cloudflare (cf-ray), from the server behind it or from Cloudflare itself. */
const viaCloudflare = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain", "cf-ray": "8f1c2a3b4d5e6f70-FRA", server: "cloudflare" } });

/**
 * One app on one node whose agent answers origin checks, with example.com
 * and www.example.com behind Cloudflare's proxy. `answer` is what a request
 * of the origin check gets; `proof` is the node's edge answering.
 */
function setup() {
  const key = nodeKey();
  const project = seedProject(panel);
  const node = seedNode(panel, { name: "de-fsn-1", ipv4: "203.0.113.10" });
  panel.deps.db.update(nodes).set({ publicKey: key.publicKey }).where(eq(nodes.id, node.id)).run();
  const service = seedService(panel, { projectId: project.id, name: "web", ports: [3000], nodeIds: [node.id], deployed: true });
  const agent = fakeAgent(panel, node.id, {}, ["getNodeFacts"], [originCapability]);
  agents.push(agent);
  let lookups = 0;
  const cloudflareDns: DnsLookups = {
    resolve4: async (name) => {
      lookups++;
      return name === "example.com" || name === "www.example.com" ? ["104.16.1.1"] : [];
    },
    resolve6: async () => [],
    resolveCname: async () => [],
    resolveNs: async (name) => (name === "example.com" ? ["ada.ns.cloudflare.com"] : []),
  };
  setDnsLookups(cloudflareDns);
  const proof = (url: string) => {
    const u = new URL(url);
    return text(
      `${sign(null, originSignedBytes(u.hostname, u.pathname.slice(originPath.length)), key.privateKey).toString("base64url")}\n`,
    );
  };
  const fetched: string[] = [];
  const s = {
    service,
    proof,
    fetched,
    lookups: () => lookups,
    answer: (url: string): Response | Promise<Response> => proof(url),
    /** The routes the node reports, and what each says (pending until a certificate is named). */
    routes: new Map<string, { state: RouteState; certificateExpiresAt?: ReturnType<typeof timestampFromDate> }>(),
    epoch: 0n,
    report() {
      s.epoch += 1n;
      agent.snapshot({
        epoch: s.epoch,
        services: [{ serviceId: service.id, routes: [...s.routes].map(([routeId, r]) => ({ routeId, ...r })) }],
      });
    },
    async add(host: string) {
      const added = await callOp(panel, domainOps.add, { serviceId: service.id, host }, { cookie });
      expect(added.status).toBe(200);
      const domainId: string = added.body.domain.id;
      s.routes.set(domainId, { state: RouteState.CERTIFICATE_PENDING });
      s.report();
      return domainId;
    },
    /** The node reports the domain's Let's Encrypt certificate. */
    certificate(domainId: string) {
      s.routes.set(domainId, { state: RouteState.ACTIVE, certificateExpiresAt: timestampFromDate(new Date(Date.now() + 90 * 24 * hour)) });
      s.report();
    },
    row: (domainId: string) => panel.deps.db.select().from(domains).where(eq(domains.id, domainId)).get(),
    async listed(domainId: string) {
      const list = (await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie })).body.domains as {
        id: string;
        origin?: string;
        originCheckedAt?: string;
        originUnknownSince?: string;
        originReason?: string;
        certificate: { status: string; waitingForDns?: boolean };
        liveAt: string | null;
      }[];
      return list.find((d) => d.id === domainId);
    },
    checkDns: async (domainId: string) => (await callOp(panel, domainOps.checkDns, { serviceId: service.id, domainId }, { cookie })).body,
    /** The job runner a moment from now: the check a few seconds after domains.add, a check enqueued since. */
    due: () => panel.runner.runDue(panel.deps, new Date(Date.now() + 30_000)),
    queuedChecks: (domainId: string) =>
      panel.deps.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, originCheckJobType), eq(jobs.status, "queued")))
        .all()
        .filter((j) => (j.payload as { domainId: string }).domainId === domainId),
    recheck: () => recheckJob.run({}, panel.deps as JobContext),
  };
  setOriginFetch(async (url) => {
    fetched.push(url);
    return s.answer(url);
  });
  return s;
}

const isWww = (url: string) => new URL(url).hostname === "www.example.com";

describe("what left www without an origin", () => {
  test("a check that began before the stored answer was taken does not replace it", async () => {
    const s = setup();
    // The apex: the node has its route and proves itself, so its certificate starts.
    const apex = await s.add("example.com");
    await s.due();
    expect(s.row(apex)).toMatchObject({ originStatus: "node" });

    // www, a moment later. The check a few seconds after domains.add goes out while the node has just
    // reported the route and Traefik does not serve it yet; Cloudflare holds that request a while.
    let late!: (response: Response) => void;
    s.answer = (url) => {
      if (!isWww(url) || s.fetched.filter(isWww).length > 1) return s.proof(url);
      return new Promise<Response>((resolve) => {
        late = resolve;
      });
    };
    const www = await s.add("www.example.com");
    const job = s.due();
    while (s.fetched.filter(isWww).length === 0) await Bun.sleep(1);

    // Meanwhile the Domains tab checks www: the node proves itself and the certificate starts.
    expect(await s.checkDns(www)).toMatchObject({ status: "proxied", origin: "node" });
    expect(s.row(www)?.acmeReleasedAt).not.toBeNull();

    // The held request comes back with Traefik's 404 from before it served the route.
    late(viaCloudflare(404, "404 page not found\n"));
    await job;
    // 0.2.15 stored it: www read "elsewhere" (and once Let's Encrypt issued, nothing at all).
    expect(s.row(www)).toMatchObject({ originStatus: "node" });

    s.certificate(www);
    expect(await s.listed(www)).toMatchObject({ origin: "node", certificate: { status: "valid" } });
    expect((await s.listed(www))?.liveAt).not.toBeNull();
  });

  test("a certificate that clears an elsewhere checks the origin again a few seconds later", async () => {
    const s = setup();
    // The check after domains.add meets another server's page: elsewhere, and the certificate waits.
    s.answer = () => text("<!doctype html><title>Old host</title>");
    const www = await s.add("www.example.com");
    await s.due();
    expect(s.row(www)).toMatchObject({ originStatus: "elsewhere" });

    // The node reports a certificate for www after all: the elsewhere is out of date.
    s.answer = s.proof;
    s.certificate(www);
    expect(s.row(www)).toMatchObject({ certStatus: "valid", originStatus: null, originCheckedAt: null, dnsStatus: "proxied" });
    // 0.2.15 stopped here, for good: proxied, a valid certificate, no origin.
    expect(s.queuedChecks(www)).toHaveLength(1);
    await s.due();
    expect(await s.listed(www)).toMatchObject({ origin: "node", certificate: { status: "valid" } });
  });

  test("a live domain with a valid certificate and no origin, as 0.2.15 left www, is checked again", async () => {
    const s = setup();
    const www = await s.add("www.example.com");
    // As on the owner's panel: the check after domains.add stored nothing that lasted, and the
    // certificate came; its last DNS check was hours ago.
    panel.deps.db.delete(jobs).run();
    s.certificate(www);
    const hoursAgo = new Date(Date.now() - 3 * hour);
    panel.deps.db
      .update(domains)
      .set({ originStatus: null, originCheckedAt: null, dnsCheckedAt: hoursAgo, createdAt: hoursAgo })
      .where(eq(domains.id, www))
      .run();
    expect(await s.listed(www)).toMatchObject({ certificate: { status: "valid" } });
    expect((await s.listed(www))?.origin).toBeUndefined();

    await s.recheck();
    expect(await s.listed(www)).toMatchObject({ origin: "node" });
    // Only the origin: a live domain's DNS is not looked up by the re-check.
    expect(s.lookups()).toBe(1);
  });
});

/**
 * Cloudflare's DNS, with the lookup of www held until `release`: a slow
 * resolver. `asked` turns true once the held lookup has started.
 */
function slowWwwDns() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { asked: false, release: () => release() };
  setDnsLookups({
    resolve4: async (name) => {
      if (name === "www.example.com") {
        state.asked = true;
        await held;
      }
      return name === "example.com" || name === "www.example.com" ? ["104.16.1.1"] : [];
    },
    resolve6: async () => [],
    resolveCname: async () => [],
    resolveNs: async (name) => (name === "example.com" ? ["ada.ns.cloudflare.com"] : []),
  });
  return state;
}

describe("a check whose DNS lookup is slow", () => {
  /**
   * www is added at t0 and a check starts with a DNS lookup that takes two
   * seconds. Meanwhile, at t0 + 1 s, the check a few seconds after
   * domains.add goes out while Traefik does not serve www's route yet:
   * its 404 through Cloudflare stores "elsewhere". At t0 + 2 s the lookup
   * answers and the check's own request goes out; the node proves itself.
   */
  async function overlap(s: ReturnType<typeof setup>, check: (domainId: string) => Promise<unknown>) {
    const t0 = Date.now();
    setSystemTime(new Date(t0));
    const www = await s.add("www.example.com");
    const dns = slowWwwDns();
    const pending = check(www);
    while (!dns.asked) await Bun.sleep(1);

    setSystemTime(new Date(t0 + 1000));
    s.answer = () => viaCloudflare(404, "404 page not found\n");
    await s.due();
    expect(s.row(www)).toMatchObject({ originStatus: "elsewhere" });

    setSystemTime(new Date(t0 + 2000));
    s.answer = s.proof;
    dns.release();
    return { www, result: await pending };
  }

  test("domains.checkDns stores the proof its request got after the other check's answer", async () => {
    const s = setup();
    const { www, result } = await overlap(s, s.checkDns);
    expect(result).toMatchObject({ status: "proxied", origin: "node" });
    // Before, the check's start was taken before its DNS lookup, so the proof looked older than the
    // 404 and was not stored: the certificate started while the row kept "elsewhere".
    expect(s.row(www)).toMatchObject({ originStatus: "node" });
    expect(s.row(www)?.acmeReleasedAt).not.toBeNull();
    expect(await s.listed(www)).toMatchObject({ origin: "node" });
  });

  test("Regenerate certificate stores the proof its request got after the other check's answer", async () => {
    const s = setup();
    const { www, result } = await overlap(s, async (domainId) => {
      const retried = await callOp(panel, domainOps.retryCertificate, { serviceId: s.service.id, domainId }, { cookie });
      expect(retried.status).toBe(200);
      return retried.body;
    });
    // The proof released the certificate: the node asks Let's Encrypt with the desired state on its way.
    expect(result).toMatchObject({ id: www, certificate: { status: "pending" } });
    expect(s.row(www)).toMatchObject({ originStatus: "node" });
    expect(s.row(www)?.acmeReleasedAt).not.toBeNull();
  });
});

describe("the re-check of origins that are not known", () => {
  test("every 2 minutes in the first hour of unknown answers, 15 minutes in the first day, then 6 hours, until it is known", async () => {
    const s = setup();
    // Live with its certificate, and Cloudflare refuses the node's certificate on the check (Full (strict)).
    s.answer = () => viaCloudflare(526, "error code: 526");
    const www = await s.add("www.example.com");
    s.certificate(www);
    const t0 = Date.now();
    await s.due();
    const first = await s.listed(www);
    expect(first).toMatchObject({ origin: "unknown", originReason: "cloudflareCertificate", certificate: { status: "valid" } });
    const since = first?.originUnknownSince;
    expect(Date.parse(since ?? "")).toBeGreaterThanOrEqual(t0);

    const checksAt = async (at: number) => {
      setSystemTime(new Date(t0 + at));
      const before = s.fetched.length;
      await s.recheck();
      return s.fetched.length - before;
    };
    // The answer just came: not due. Two minutes later: due, and the run keeps its start.
    expect(await checksAt(1 * minute)).toBe(0);
    expect(await checksAt(2 * minute + 1000)).toBe(1);
    expect((await s.listed(www))?.originUnknownSince).toBe(since);
    expect(Date.parse((await s.listed(www))?.originCheckedAt ?? "")).toBe(t0 + 2 * minute + 1000);
    // After an hour of unknown answers, every 15 minutes.
    expect(await checksAt(70 * minute)).toBe(1);
    expect(await checksAt(80 * minute)).toBe(0);
    expect(await checksAt(86 * minute)).toBe(1);
    // After a day, every 6 hours.
    expect(await checksAt(25 * hour)).toBe(1);
    expect(await checksAt(29 * hour)).toBe(0);
    expect(await checksAt(31 * hour + minute)).toBe(1);
    expect((await s.listed(www))?.originUnknownSince).toBe(since);
    // No DNS lookups for any of them.
    expect(s.lookups()).toBe(1);

    // SSL/TLS set to Full: the node proves itself, the run ends, and the domain is not checked again.
    s.answer = s.proof;
    expect(await checksAt(38 * hour)).toBe(1);
    expect(s.row(www)).toMatchObject({ originStatus: "node", originUnknownSince: null });
    expect((await s.listed(www))?.originUnknownSince).toBeUndefined();
    expect(await checksAt(100 * hour)).toBe(0);
  });

  test("a domain whose certificate waits is checked once per run, by the DNS re-check", async () => {
    const s = setup();
    s.answer = () => viaCloudflare(526, "error code: 526");
    const www = await s.add("www.example.com");
    await s.due();
    expect(s.row(www)).toMatchObject({ originStatus: "unknown" });
    expect((await s.listed(www))?.certificate.waitingForDns).toBe(true);
    expect(originRecheckDue(s.row(www) as never, Date.now() + hour)).toBe(false);
    setSystemTime(new Date(Date.now() + 3 * minute));
    const before = s.fetched.length;
    await s.recheck();
    expect(s.fetched.length - before).toBe(1);
    expect(s.lookups()).toBe(2);
  });

  test("known origins, forwards and DNS that does not point anywhere yet are not re-checked", () => {
    const s = setup();
    const base = {
      auto: false,
      forward: null,
      https: "acme",
      dnsStatus: "proxied",
      originStatus: null,
      originCheckedAt: null,
      originUnknownSince: null,
      acmeReleasedAt: new Date(0),
      certStatus: "valid",
      certExpiresAt: null,
      liveAt: new Date(0),
      dnsCheckedAt: new Date(0),
      createdAt: new Date(0),
    };
    const due = (over: Record<string, unknown>) => originRecheckDue({ ...base, ...over } as never);
    expect(due({})).toBe(true);
    expect(due({ dnsStatus: "ok", originStatus: "unknown", originCheckedAt: new Date(0) })).toBe(true);
    expect(due({ originStatus: "node", originCheckedAt: new Date(0) })).toBe(false);
    expect(due({ originStatus: "elsewhere", originCheckedAt: new Date(0) })).toBe(false);
    expect(due({ forward: { url: "https://example.com", permanent: true, keepPath: true } })).toBe(false);
    expect(due({ auto: true })).toBe(false);
    expect(due({ dnsStatus: "missing" })).toBe(false);
    expect(due({ dnsStatus: "unknown" })).toBe(false);
    void s;
  });
});

describe("what is stored while the origin is unknown", () => {
  test("originUnknownSince keeps the run's first unknown answer, and any other answer clears it", async () => {
    const s = setup();
    s.answer = () => viaCloudflare(522, "error code: 522");
    const www = await s.add("www.example.com");
    s.certificate(www);
    await s.due();
    const since = s.row(www)?.originUnknownSince?.getTime();
    expect(since).toBeNumber();
    expect(await s.listed(www)).toMatchObject({ origin: "unknown", originReason: "cloudflareUnreachable" });

    // Check again a minute later, still unknown (no answer at all this time): same run.
    setSystemTime(new Date(Date.now() + minute));
    s.answer = () => Promise.reject(new TypeError("timed out"));
    expect((await s.checkDns(www)).origin).toBe("unknown");
    expect(s.row(www)?.originUnknownSince?.getTime()).toBe(since);
    expect((await s.listed(www))?.originReason).toBeUndefined();

    // Something else answers: elsewhere, and no run.
    s.answer = () => text("<!doctype html><title>Old host</title>");
    expect((await s.checkDns(www)).origin).toBe("elsewhere");
    expect(s.row(www)?.originUnknownSince).toBeNull();
    expect((await s.listed(www))?.originUnknownSince).toBeUndefined();

    // Unknown again: a new run starts now.
    setSystemTime(new Date(Date.now() + minute));
    s.answer = () => viaCloudflare(522, "error code: 522");
    await s.checkDns(www);
    expect(s.row(www)?.originUnknownSince?.getTime()).toBe(Date.now());

    // The record leaves Cloudflare and DNS: the origin and its run go.
    setDnsLookups({ resolve4: async () => [], resolve6: async () => [], resolveCname: async () => [], resolveNs: async () => [] });
    expect((await s.checkDns(www)).status).toBe("missing");
    expect(s.row(www)).toMatchObject({ originStatus: null, originUnknownSince: null });
  });
});
