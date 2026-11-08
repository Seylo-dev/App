import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { domains as domainOps, exposures as exposureOps } from "@seylo/ops";
import { HttpsMode, PublicPortMode, RouteState } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { alerts } from "../src/db/schema";
import { serviceNetworking } from "../src/modules/domains/desired";
import { classifyRecords, type DnsLookups, isCloudflareIp, relativeName, setDnsLookups } from "../src/modules/domains/dns";
import { openFirstRun } from "../src/modules/exposures/logic";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
beforeEach(async () => {
  panel = testPanel();
  cookie = (await createUser(panel, "owner")).cookie;
});
afterEach(() => {
  setDnsLookups(null);
  panel.close();
});

function fakeDns(records: { a?: Record<string, string[]>; aaaa?: Record<string, string[]>; ns?: Record<string, string[]> }): DnsLookups {
  return {
    resolve4: async (name) => records.a?.[name] ?? [],
    resolve6: async (name) => records.aaaa?.[name] ?? [],
    resolveCname: async () => [],
    resolveNs: async (name) => records.ns?.[name] ?? [],
  };
}

function setup() {
  const project = seedProject(panel);
  const node = seedNode(panel, { name: "de-fsn-1", ipv4: "203.0.113.10", wildcard: "n1.example.com" });
  const service = seedService(panel, { projectId: project.id, name: "web", ports: [3000], nodeIds: [node.id] });
  return { project, node, service };
}

describe("dns classification", () => {
  test("records are ok, missing, proxied or pointing elsewhere", () => {
    const node = new Set(["203.0.113.10"]);
    expect(classifyRecords(["203.0.113.10", "198.51.100.1"], node)).toBe("ok");
    expect(classifyRecords([], node)).toBe("missing");
    expect(classifyRecords(["104.16.1.1", "172.67.2.2"], node)).toBe("proxied");
    expect(classifyRecords(["198.51.100.1"], node)).toBe("wrongTarget");
    expect(isCloudflareIp("2606:4700::6810:1")).toBe(true);
    expect(isCloudflareIp("2001:db8::1")).toBe(false);
    expect(relativeName("shop.example.com", "example.com")).toBe("shop");
    expect(relativeName("example.com", "example.com")).toBe("@");
  });
});

describe("domains ops", () => {
  test("automatic domain from the node's wildcard becomes primary and is routed", async () => {
    const { service, node } = setup();
    const listed = await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie });
    expect(listed.body).toEqual({ domains: [], autoDomainSuggestion: "web.n1.example.com" });

    panel.deps.agents.desired.takeDirty();
    const added = await callOp(panel, domainOps.addAuto, { serviceId: service.id }, { cookie });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ host: "web.n1.example.com", auto: true, primary: true, dnsStatus: "ok", targetPort: 3000 });
    expect(added.body.url).toBe("https://web.n1.example.com");
    expect(panel.deps.agents.desired.takeDirty()).toEqual([{ serviceId: service.id }]);

    const again = await callOp(panel, domainOps.addAuto, { serviceId: service.id }, { cookie });
    expect(again.status).toBe(409);

    const net = serviceNetworking(panel.deps, service.id, node.id);
    expect(net.routing.routes).toHaveLength(1);
    expect(net.routing.routes?.[0]).toMatchObject({
      hosts: ["web.n1.example.com"],
      targetPort: 3000,
      https: HttpsMode.ACME,
      redirectToHttps: true,
    });
  });

  test("custom domains get a DNS check with records to create and the Cloudflare link", async () => {
    const { service } = setup();
    setDnsLookups(
      fakeDns({
        a: { "shop.example.com": ["104.16.1.1"], "api.other.org": ["203.0.113.10"] },
        ns: { "example.com": ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], "other.org": ["ns1.registrar.net"] },
      }),
    );
    const proxied = await callOp(panel, domainOps.add, { serviceId: service.id, host: "shop.example.com" }, { cookie });
    expect(proxied.status).toBe(200);
    expect(proxied.body.domain).toMatchObject({ primary: true, dnsStatus: "proxied", certificate: { status: "pending" } });
    expect(proxied.body.dns).toMatchObject({
      status: "proxied",
      zone: "example.com",
      cloudflareManaged: true,
      cloudflareDnsUrl: "https://dash.cloudflare.com/?to=/:account/example.com/dns/records",
      expected: [{ type: "A", name: "shop", value: "203.0.113.10" }],
      found: [{ type: "A", name: "shop", value: "104.16.1.1" }],
    });
    // Let's Encrypt checks over plain HTTP, so the message says what Cloudflare needs for the certificate.
    expect(proxied.body.dns.message).toContain("point it at 203.0.113.10, set SSL/TLS to Full (strict) and turn off Always Use HTTPS");

    const ok = await callOp(
      panel,
      domainOps.add,
      { serviceId: service.id, host: "api.other.org", pathPrefix: "/v1", stripPrefix: true },
      { cookie },
    );
    expect(ok.body.domain).toMatchObject({ primary: false, dnsStatus: "ok", url: "https://api.other.org/v1" });
    expect(ok.body.dns).toMatchObject({ status: "ok", cloudflareManaged: false, cloudflareDnsUrl: null });

    const missing = await callOp(panel, domainOps.add, { serviceId: service.id, host: "new.other.org" }, { cookie });
    expect(missing.body.dns.status).toBe("missing");
    expect(missing.body.dns.message).toContain("No A record");

    const dup = await callOp(panel, domainOps.add, { serviceId: service.id, host: "api.other.org", pathPrefix: "/v1" }, { cookie });
    expect(dup.status).toBe(409);

    // Re-checking after the record was fixed refreshes the stored status.
    setDnsLookups(fakeDns({ a: { "new.other.org": ["203.0.113.10"] }, ns: { "other.org": ["ns1.registrar.net"] } }));
    const checked = await callOp(panel, domainOps.checkDns, { serviceId: service.id, domainId: missing.body.domain.id }, { cookie });
    expect(checked.body.status).toBe("ok");
    const list = await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie });
    expect(list.body.domains.map((d: { host: string; dnsStatus: string }) => [d.host, d.dnsStatus])).toEqual([
      ["shop.example.com", "proxied"],
      ["api.other.org", "ok"],
      ["new.other.org", "ok"],
    ]);
  });

  test("middlewares: hashed basic auth, CIDRs, rate limit and redirects reach the route", async () => {
    const { service, node } = setup();
    setDnsLookups(fakeDns({}));
    const { body } = await callOp(panel, domainOps.add, { serviceId: service.id, host: "admin.example.com" }, { cookie });
    const ref = { serviceId: service.id, domainId: body.domain.id };

    const set = await callOp(
      panel,
      domainOps.setMiddlewares,
      {
        ...ref,
        basicAuth: { users: [{ username: "ops", password: "correct horse" }] },
        ipAllowList: ["198.51.100.7", "10.0.0.0/8", "2001:DB8::/32"],
        rateLimit: { average: 50, burst: 100, periodSeconds: 1 },
        redirects: [{ from: "^https://admin.example.com/old/(.*)", to: "https://admin.example.com/new/$1", permanent: true }],
      },
      { cookie },
    );
    expect(set.status).toBe(200);
    expect(set.body.middlewares).toEqual({
      basicAuth: { usernames: ["ops"] },
      ipAllowList: ["198.51.100.7/32", "10.0.0.0/8", "2001:db8::/32"],
      rateLimit: { average: 50, burst: 100, periodSeconds: 1 },
      redirects: [{ from: "^https://admin.example.com/old/(.*)", to: "https://admin.example.com/new/$1", permanent: true }],
    });
    expect(JSON.stringify(set.body)).not.toContain("$2");

    const route = serviceNetworking(panel.deps, service.id, node.id).routing.routes?.[0];
    const hash = route?.basicAuth?.users?.[0]?.passwordHash ?? "";
    expect(hash.startsWith("$2y$10$")).toBe(true);
    expect(await Bun.password.verify("correct horse", hash.replace("$2y$", "$2b$"))).toBe(true);
    expect(route?.allowedSourceCidrs).toEqual(["198.51.100.7/32", "10.0.0.0/8", "2001:db8::/32"]);
    expect(route?.rateLimit).toMatchObject({ average: 50, burst: 100 });

    // A user without a password keeps the stored hash; a new user needs one.
    await callOp(panel, domainOps.setMiddlewares, { ...ref, basicAuth: { users: [{ username: "ops" }] } }, { cookie });
    expect(serviceNetworking(panel.deps, service.id, node.id).routing.routes?.[0]?.basicAuth?.users?.[0]?.passwordHash).toBe(hash);
    const newUser = await callOp(panel, domainOps.setMiddlewares, { ...ref, basicAuth: { users: [{ username: "dev" }] } }, { cookie });
    expect(newUser.status).toBe(400);

    const badCidr = await callOp(panel, domainOps.setMiddlewares, { ...ref, ipAllowList: ["10.0.0.0/33"] }, { cookie });
    expect(badCidr.status).toBe(400);
    const badRegex = await callOp(
      panel,
      domainOps.setMiddlewares,
      { ...ref, redirects: [{ from: "(", to: "x", permanent: false }] },
      { cookie },
    );
    expect(badRegex.status).toBe(400);

    const off = await callOp(panel, domainOps.setMiddlewares, { ...ref, basicAuth: null, ipAllowList: [], rateLimit: null }, { cookie });
    expect(off.body.middlewares).toMatchObject({ basicAuth: null, ipAllowList: [], rateLimit: null });
  });

  test("custom certificates are checked against the host and key", async () => {
    const { service, node } = setup();
    setDnsLookups(fakeDns({}));
    const { body } = await callOp(panel, domainOps.add, { serviceId: service.id, host: "secure.example.com" }, { cookie });
    const ref = { serviceId: service.id, domainId: body.domain.id };
    const good = selfSigned("secure.example.com");
    const other = selfSigned("other.example.com");

    const wrongHost = await callOp(panel, domainOps.setCertificate, { ...ref, certPem: other.cert, privateKey: other.key }, { cookie });
    expect(wrongHost.status).toBe(400);
    const wrongKey = await callOp(panel, domainOps.setCertificate, { ...ref, certPem: good.cert, privateKey: other.key }, { cookie });
    expect(wrongKey.status).toBe(400);

    const ok = await callOp(panel, domainOps.setCertificate, { ...ref, certPem: good.cert, privateKey: good.key }, { cookie });
    expect(ok.body.error).toBeUndefined();
    expect(ok.body).toMatchObject({ https: "custom", certificate: { status: "valid", issuer: "Seylo Test" } });
    expect(JSON.stringify(ok.body)).not.toContain("PRIVATE KEY");
    const route = serviceNetworking(panel.deps, service.id, node.id).routing.routes?.[0];
    expect(route?.https).toBe(HttpsMode.CUSTOM_CERTIFICATE);
    expect(route?.certificate?.keyPem).toContain("PRIVATE KEY");
  });

  test("forward domains redirect, primary moves on remove", async () => {
    const { service, node } = setup();
    setDnsLookups(fakeDns({}));
    const apex = await callOp(panel, domainOps.add, { serviceId: service.id, host: "example.com" }, { cookie });
    const www = await callOp(
      panel,
      domainOps.add,
      { serviceId: service.id, host: "www.example.com", forward: { url: "https://example.com", permanent: true, keepPath: true } },
      { cookie },
    );
    const second = await callOp(panel, domainOps.add, { serviceId: service.id, host: "app.example.com" }, { cookie });
    expect(www.body.domain.primary).toBe(false);
    const cannot = await callOp(panel, domainOps.setPrimary, { serviceId: service.id, domainId: www.body.domain.id }, { cookie });
    expect(cannot.status).toBe(400);

    const routes = serviceNetworking(panel.deps, service.id, node.id).routing.routes ?? [];
    const forward = routes.find((r) => r.hosts?.[0] === "www.example.com");
    expect(forward?.redirects?.[0]).toEqual({
      from: "^https?://www\\.example\\.com(?::\\d+)?(/.*)?$",
      to: "https://example.com$1",
      permanent: true,
    });
    expect(new RegExp(forward?.redirects?.[0]?.from ?? "").test("https://www.example.com/a?b=1")).toBe(true);

    const removed = await callOp(panel, domainOps.remove, { serviceId: service.id, domainId: apex.body.domain.id }, { cookie });
    expect(removed.status).toBe(200);
    const list = await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie });
    expect(list.body.domains.find((d: { primary: boolean }) => d.primary)?.id).toBe(second.body.domain.id);
  });

  test("when the primary domain goes live, first-run IP:port redirects to it and closes later", async () => {
    const { service, node } = setup();
    setDnsLookups(fakeDns({}));
    expect(openFirstRun(panel.deps.db, service.id)).toBe(true);
    const agent = fakeAgent(panel, node.id);
    agent.snapshot({ epoch: 1n, services: [{ serviceId: service.id, openPorts: [{ hostPort: 41203, containerPort: 3000 }] }] });
    // The port the agent picked was recorded by the exposures module (see dev-access.test.ts); check the status here.
    const { body } = await callOp(panel, domainOps.add, { serviceId: service.id, host: "shop.example.com" }, { cookie });
    expect((await callOp(panel, exposureOps.get, { serviceId: service.id }, { cookie })).body.firstRun.status).toBe("open");

    panel.deps.agents.desired.takeDirty();
    agent.snapshot({
      epoch: 1n,
      seq: 2n,
      services: [
        {
          serviceId: service.id,
          routes: [{ routeId: body.domain.id, state: RouteState.ACTIVE }],
          openPorts: [{ hostPort: 41203, containerPort: 3000 }],
        },
      ],
    });
    const list = await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie });
    expect(list.body.domains[0]).toMatchObject({ dnsStatus: "ok", certificate: { status: "valid", issuer: "Let's Encrypt" } });
    expect(list.body.domains[0].liveAt).not.toBeNull();

    const access = await callOp(panel, exposureOps.get, { serviceId: service.id }, { cookie });
    expect(access.body.firstRun).toMatchObject({ status: "redirecting", redirectTo: "https://shop.example.com" });
    const closeAt = new Date(access.body.firstRun.closeAt).getTime();
    expect(closeAt - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(panel.deps.agents.desired.takeDirty()).toContainEqual({ serviceId: service.id });

    const port = serviceNetworking(panel.deps, service.id, node.id).publicPorts[0];
    expect(port).toMatchObject({ containerPort: 3000, mode: PublicPortMode.REDIRECT, redirectUrl: "https://shop.example.com" });
    agent.disconnect();
  });

  test("a failed certificate shows its error, alerts once, and clears when the route goes live", async () => {
    const { service, node } = setup();
    setDnsLookups(fakeDns({}));
    const { body } = await callOp(panel, domainOps.add, { serviceId: service.id, host: "shop.example.com" }, { cookie });
    const agent = fakeAgent(panel, node.id);
    const failed = {
      serviceId: service.id,
      routes: [{ routeId: body.domain.id, state: RouteState.CERTIFICATE_FAILED, message: "acme: rateLimited: too many certificates" }],
    };
    agent.snapshot({ epoch: 1n, services: [failed] });
    agent.snapshot({ epoch: 1n, seq: 2n, services: [failed] });
    let list = await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie });
    expect(list.body.domains[0].certificate).toMatchObject({ status: "failed", error: "acme: rateLimited: too many certificates" });
    const open = panel.deps.db.select().from(alerts).all();
    expect(open.map((a) => [a.event, a.serviceId, a.resolvedAt])).toEqual([["certificate_failed", service.id, null]]);

    const expires = Math.floor(Date.now() / 1000) + 90 * 86_400;
    agent.snapshot({
      epoch: 1n,
      seq: 3n,
      services: [
        {
          serviceId: service.id,
          routes: [
            {
              routeId: body.domain.id,
              state: RouteState.ACTIVE,
              certificateIssuer: "R11",
              certificateExpiresAt: { seconds: BigInt(expires), nanos: 0 },
            },
          ],
        },
      ],
    });
    list = await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie });
    expect(list.body.domains[0].certificate).toEqual({
      status: "valid",
      expiresAt: new Date(expires * 1000).toISOString(),
      issuer: "Let's Encrypt (R11)",
      error: null,
    });
    expect(panel.deps.db.select().from(alerts).where(eq(alerts.event, "certificate_failed")).get()?.resolvedAt).not.toBeNull();
    agent.disconnect();
  });

  test("members need domains.view to read and domains.edit to change", async () => {
    const { service } = setup();
    const member = await createUser(panel, "member");
    expect((await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie: member.cookie })).status).toBe(403);
    grant(panel, member.user.id, "service", service.id, ["domains.view"]);
    expect((await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie: member.cookie })).status).toBe(200);
    expect((await callOp(panel, domainOps.addAuto, { serviceId: service.id }, { cookie: member.cookie })).status).toBe(403);
  });
});

function selfSigned(host: string): { cert: string; key: string } {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/seylo-cert-${crypto.randomUUID()}`;
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
    `/O=Seylo Test/CN=${host}`,
    "-addext",
    `subjectAltName=DNS:${host}`,
    "-keyout",
    `${dir}/key.pem`,
    "-out",
    `${dir}/cert.pem`,
  ]);
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  const out = {
    cert: require("node:fs").readFileSync(`${dir}/cert.pem`, "utf8"),
    key: require("node:fs").readFileSync(`${dir}/key.pem`, "utf8"),
  };
  Bun.spawnSync(["rm", "-rf", dir]);
  return out;
}
