// DOMAINS (0.2.16): every host an app answers on, comma separated, primary
// first and then the Domains tab's order, redirect-only domains left out,
// a host with several paths once, and ${{svc.DOMAINS[n]}} for one of them.
// The graph fills it next to DOMAIN, env.references sends it as a list,
// deploys resolve it like DOMAIN (on the next deploy after a domain
// change), and saves check the index like any reference.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { analyzeEnv } from "@seylo/env-analyzer";
import { domains as domainOps, env as envOps } from "@seylo/ops";
import { domains } from "../src/db/schema";
import { setDnsLookups } from "../src/modules/domains/dns";
import { deploymentEnv, resolveServiceEnv, sealDeploymentEnv } from "../src/modules/env/desired";
import { buildEnvGraph, domainHosts } from "../src/modules/env/graph";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
beforeEach(async () => {
  panel = testPanel();
  cookie = (await createUser(panel, "owner")).cookie;
  setDnsLookups({ resolve4: async () => [], resolve6: async () => [], resolveCname: async () => [], resolveNs: async () => [] });
});
afterEach(() => {
  setDnsLookups(null);
  panel.close();
});

/** api and web on one node; api gets its domains in order, a little apart so createdAt orders them. */
async function world() {
  const project = seedProject(panel);
  const node = seedNode(panel, { name: "de-fsn-1", wildcard: "fsn.example.com" });
  const api = seedService(panel, { projectId: project.id, name: "api", ports: [3000], nodeIds: [node.id] });
  const web = seedService(panel, { projectId: project.id, name: "web", ports: [8080], nodeIds: [node.id] });
  return { project, node, api, web };
}

async function addDomain(serviceId: string, input: Record<string, unknown>): Promise<string> {
  await Bun.sleep(3);
  const res = await callOp(panel, domainOps.add, { serviceId, ...input } as never, { cookie });
  expect(res.status).toBe(200);
  return res.body.domain.id as string;
}

/** api's domains: api.example.com (primary), a redirect-only www, api.example.org, a second path on api.example.org, edge.example.net. */
async function apiDomains(serviceId: string) {
  const primary = await addDomain(serviceId, { host: "api.example.com" });
  const forward = await addDomain(serviceId, {
    host: "www.api.example.com",
    forward: { url: "https://api.example.com", permanent: true, keepPath: true },
  });
  const org = await addDomain(serviceId, { host: "api.example.org" });
  await addDomain(serviceId, { host: "api.example.org", pathPrefix: "/v2" });
  const net = await addDomain(serviceId, { host: "edge.example.net" });
  return { primary, forward, org, net };
}

const builtinsOf = async (serviceId: string, target: string) => {
  const ctx = await callOp(panel, envOps.references, { serviceId }, { cookie });
  expect(ctx.status).toBe(200);
  const variables: { name: string; value: string | null; list?: boolean }[] =
    target === "self" ? ctx.body.self.builtins : ctx.body.targets.find((t: { name: string }) => t.name === target).variables;
  return { ctx: ctx.body, variables, value: (name: string) => variables.find((v) => v.name === name)?.value };
};

const resolved = (serviceId: string) => Object.fromEntries(resolveServiceEnv(panel.deps, serviceId).map((v) => [v.name, v.value]));

describe("DOMAINS in the env graph", () => {
  test("every host, primary first then the Domains tab's order; no redirect-only domain; a host with two paths once", async () => {
    const { api, web } = await world();
    await apiDomains(api.id);
    expect(domainHosts(panel.deps.db, api.id)).toEqual(["api.example.com", "api.example.org", "edge.example.net"]);
    // The Domains tab lists the same order (with the forward and the second path, which DOMAINS leaves out).
    const listed = await callOp(panel, domainOps.list, { serviceId: api.id }, { cookie });
    expect(listed.body.domains.map((d: { host: string; pathPrefix: string }) => `${d.host}${d.pathPrefix}`)).toEqual([
      "api.example.com/",
      "www.api.example.com/",
      "api.example.org/",
      "api.example.org/v2",
      "edge.example.net/",
    ]);

    const { variables, value } = await builtinsOf(web.id, "api");
    expect(variables.map((v) => v.name)).toEqual(["URL", "DOMAIN", "DOMAINS", "INTERNAL_URL", "INTERNAL_HOST", "INTERNAL_PORT"]);
    expect(variables.find((v) => v.name === "DOMAINS")).toEqual({
      name: "DOMAINS",
      value: "api.example.com,api.example.org,edge.example.net",
      scope: "public",
      sensitive: false,
      description: "all domain hosts, primary first, comma separated",
      list: true,
    });
    // No other variable is a list.
    expect(variables.filter((v) => v.list).map((v) => v.name)).toEqual(["DOMAINS"]);
    expect(value("DOMAIN")).toBe("api.example.com");
    // A service without a domain: empty, like DOMAIN.
    const own = await builtinsOf(web.id, "self");
    expect([own.value("DOMAIN"), own.value("DOMAINS")]).toEqual(["", ""]);
  });

  test("a wildcard host is listed as written", async () => {
    const { api } = await world();
    await addDomain(api.id, { host: "api.example.com" });
    await Bun.sleep(3);
    panel.deps.db.insert(domains).values({ serviceId: api.id, host: "*.tenants.example.com", targetPort: 3000 }).run();
    expect(domainHosts(panel.deps.db, api.id)).toEqual(["api.example.com", "*.tenants.example.com"]);
    expect(buildEnvGraph(panel.deps, api.projectId).value("api", "DOMAINS")).toBe("api.example.com,*.tenants.example.com");
  });
});

describe("resolving DOMAINS for a deploy", () => {
  test("the whole list, one item, past the end, the service's own, and an index on a variable that is no list", async () => {
    const { api, web } = await world();
    await apiDomains(api.id);
    await addDomain(web.id, { host: "shop.example.com" });
    await addDomain(web.id, { host: "www.shop.example.com" });
    const text = [
      "ALLOWED_HOSTS=${{api.DOMAINS}}",
      "PRIMARY=${{api.DOMAINS[0]}}",
      "MIRROR=https://${{api.DOMAINS[1]}}/v1",
      "EDGE=${{api.DOMAINS[2]}}",
      "PAST=${{api.DOMAINS[3]}}",
      "OWN=${{web.DOMAINS}}",
      "OWN_WWW=${{web.DOMAINS[1]}}",
      "BAD=${{api.URL[1]}}",
      "",
    ].join("\n");
    const saved = await callOp(panel, envOps.set, { serviceId: web.id, text }, { cookie });
    expect(saved.status).toBe(200);
    expect(
      saved.body.diagnostics.map((d: { code: string; severity: string; range: { startLine: number } }) => [
        d.code,
        d.severity,
        d.range.startLine,
      ]),
    ).toEqual([
      ["index-out-of-range", "warning", 5],
      ["not-a-list", "error", 8],
    ]);
    expect(saved.body.diagnostics[0].message).toBe("api has 3 domains: DOMAINS[0] to DOMAINS[2]");
    expect(saved.body.diagnostics[1].message).toBe("URL is not a list, so it takes no [1]");

    expect(resolved(web.id)).toMatchObject({
      ALLOWED_HOSTS: "api.example.com,api.example.org,edge.example.net",
      PRIMARY: "api.example.com",
      MIRROR: "https://api.example.org/v1",
      EDGE: "edge.example.net",
      PAST: "",
      OWN: "shop.example.com,www.shop.example.com",
      OWN_WWW: "www.shop.example.com",
      // Not a list: stays as written, like a reference to an unknown variable.
      BAD: "${{api.URL[1]}}",
    });
    // A reference to a variable that holds an indexed reference follows it too.
    await callOp(panel, envOps.set, { serviceId: api.id, text: "SECOND=${{api.DOMAINS[1]}}\n" }, { cookie });
    await callOp(panel, envOps.set, { serviceId: web.id, text: "FROM_API=${{api.SECOND}}\n" }, { cookie });
    expect(resolved(web.id)).toMatchObject({ FROM_API: "api.example.org" });
  });

  test("a domain change moves DOMAINS like DOMAIN: env.references at once, a running deployment on its next deploy", async () => {
    const { api, web } = await world();
    const ids = await apiDomains(api.id);
    await callOp(
      panel,
      envOps.set,
      { serviceId: web.id, text: "HOST=${{api.DOMAIN}}\nHOSTS=${{api.DOMAINS}}\nSECOND=${{api.DOMAINS[1]}}\n" },
      { cookie },
    );
    const deployed = sealDeploymentEnv(panel.deps, web.id);
    const sealedValues = () => Object.fromEntries((deploymentEnv(panel.deps, deployed) ?? []).map((v) => [v.name, v.value]));
    expect(sealedValues()).toMatchObject({
      HOST: "api.example.com",
      HOSTS: "api.example.com,api.example.org,edge.example.net",
      SECOND: "api.example.org",
    });

    // Another primary: it goes first, the old one takes its place in the order.
    expect((await callOp(panel, domainOps.setPrimary, { serviceId: api.id, domainId: ids.net }, { cookie })).status).toBe(200);
    expect((await builtinsOf(web.id, "api")).value("DOMAINS")).toBe("edge.example.net,api.example.com,api.example.org");
    expect(resolved(web.id)).toMatchObject({
      HOST: "edge.example.net",
      HOSTS: "edge.example.net,api.example.com,api.example.org",
      SECOND: "api.example.com",
    });

    // Removed: gone from the list. A domain turned into a redirect: left out like any redirect-only one.
    expect((await callOp(panel, domainOps.remove, { serviceId: api.id, domainId: ids.primary }, { cookie })).status).toBe(200);
    expect((await builtinsOf(web.id, "api")).value("DOMAINS")).toBe("edge.example.net,api.example.org");
    const redirected = await callOp(
      panel,
      domainOps.update,
      { serviceId: api.id, domainId: ids.org, forward: { url: "https://edge.example.net", permanent: true, keepPath: false } },
      { cookie },
    );
    expect(redirected.status).toBe(200);
    // api.example.org/v2 still serves the app: the host stays.
    expect((await builtinsOf(web.id, "api")).value("DOMAINS")).toBe("edge.example.net,api.example.org");
    // Added: at the end.
    await addDomain(api.id, { host: "late.example.com" });
    expect(resolved(web.id)).toMatchObject({
      HOST: "edge.example.net",
      HOSTS: "edge.example.net,api.example.org,late.example.com",
      SECOND: "api.example.org",
    });

    // The deployment that runs keeps what it was deployed with, DOMAIN as well as DOMAINS; the next deploy seals the new ones.
    expect(sealedValues()).toMatchObject({ HOST: "api.example.com", HOSTS: "api.example.com,api.example.org,edge.example.net" });
    const next = Object.fromEntries((deploymentEnv(panel.deps, sealDeploymentEnv(panel.deps, web.id)) ?? []).map((v) => [v.name, v.value]));
    expect(next).toMatchObject({ HOST: "edge.example.net", HOSTS: "edge.example.net,api.example.org,late.example.com" });
  });
});

describe("saving references with an index", () => {
  test("a malformed index is a syntax error that blocks the save", async () => {
    const { web } = await world();
    for (const ref of ["DOMAINS[-1]", "DOMAINS[]", "DOMAINS[ 1 ]", "DOMAINS[x]"]) {
      const res = await callOp(panel, envOps.set, { serviceId: web.id, text: `A=\${{api.${ref}}}\n` }, { cookie });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toMatchObject({ code: "malformed-reference", line: "1" });
      expect(res.body.error.message).toContain("must be a whole number");
    }
  });

  test("DOMAINS is an address: a member who cannot read api's variables may still reference its domains", async () => {
    const { api, web } = await world();
    await apiDomains(api.id);
    await callOp(panel, envOps.set, { serviceId: api.id, text: "TOKEN=abc\n" }, { cookie });
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", web.id, ["env.view", "env.edit"]);
    const ok = await callOp(
      panel,
      envOps.set,
      { serviceId: web.id, text: "HOSTS=${{api.DOMAINS}}\nSECOND=${{api.DOMAINS[1]}}\n" },
      { cookie: member.cookie },
    );
    expect(ok.status).toBe(200);
    const hidden = await callOp(panel, envOps.set, { serviceId: web.id, text: "T=${{api.TOKEN}}\n" }, { cookie: member.cookie });
    expect(hidden.status).toBe(403);
    // What the member's editor gets analyzes the same as the save.
    const ctx = await callOp(panel, envOps.references, { serviceId: web.id }, { cookie: member.cookie });
    expect(analyzeEnv("SECOND=${{api.DOMAINS[1]}}\nPAST=${{api.DOMAINS[7]}}\n", ctx.body).diagnostics.map((d) => d.code)).toEqual([
      "index-out-of-range",
    ]);
  });

  test("shared variables take no references, with an index neither", async () => {
    const { project } = await world();
    const res = await callOp(panel, envOps.setShared, { projectId: project.id, text: "HOSTS=${{api.DOMAINS[1]}}\n" }, { cookie });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Line 1: shared variables cannot reference services. Write the value instead.");
  });
});
