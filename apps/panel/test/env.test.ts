import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { analyzeEnv } from "@seylo/env-analyzer";
import { databases as dbOps, domains as domainOps, env as envOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { projectEnv, serviceEnv } from "../src/db/schema";
import { setDnsLookups } from "../src/modules/domains/dns";
import { resolveServiceEnv } from "../src/modules/env/desired";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService, settleDeploys } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
beforeEach(async () => {
  panel = testPanel();
  cookie = (await createUser(panel, "owner")).cookie;
  setDnsLookups({ resolve4: async () => [], resolve6: async () => [], resolveCname: async () => [], resolveNs: async () => [] });
});
afterEach(async () => {
  setDnsLookups(null);
  // databases.create queues a deploy; let it settle before the database closes.
  await settleDeploys(panel);
  panel.close();
});

/** api and web on de-fsn-1, worker on us-ash-1, a Postgres on de-fsn-1. */
async function world() {
  const project = seedProject(panel);
  const fsn = seedNode(panel, { name: "de-fsn-1", ipv4: "203.0.113.10", wildcard: "fsn.example.com" });
  const ash = seedNode(panel, { name: "us-ash-1", ipv4: "198.51.100.20", wildcard: null });
  const api = seedService(panel, { projectId: project.id, name: "api", ports: [3000], nodeIds: [fsn.id] });
  const web = seedService(panel, { projectId: project.id, name: "web", ports: [8080], nodeIds: [fsn.id] });
  const worker = seedService(panel, { projectId: project.id, name: "worker", ports: [], nodeIds: [ash.id] });
  const db = await callOp(panel, dbOps.create, { projectId: project.id, name: "db", engine: "postgres", nodeId: fsn.id }, { cookie });
  return { project, fsn, ash, api, web, worker, dbId: db.body.serviceId as string };
}

const set = (serviceId: string, text: string, extra: Record<string, unknown> = {}) =>
  callOp(panel, envOps.set, { serviceId, text, ...extra } as never, { cookie });

describe("env ops", () => {
  test("text is sealed at rest and returned with parsed variables", async () => {
    const { api } = await world();
    const saved = await set(api.id, "PORT=3000\n# comment\nSECRET_KEY=hunter2hunter2\n");
    expect(saved.status).toBe(200);
    expect(saved.body.diagnostics).toEqual([]);
    const row = panel.deps.db.select().from(serviceEnv).where(eq(serviceEnv.serviceId, api.id)).get();
    expect(row?.contentSealed).not.toContain("hunter2");

    const got = await callOp(panel, envOps.get, { serviceId: api.id }, { cookie });
    expect(got.body).toMatchObject({
      text: "PORT=3000\n# comment\nSECRET_KEY=hunter2hunter2\n",
      variables: [
        { key: "PORT", value: "3000", line: 1 },
        { key: "SECRET_KEY", value: "hunter2hunter2", line: 3 },
      ],
      sharedCount: 0,
    });
    expect(got.body.updatedAt).toBe(saved.body.updatedAt);
  });

  test("syntax errors are refused; context problems are saved and returned", async () => {
    const { api } = await world();
    const broken = await set(api.id, 'A="unterminated\n');
    expect(broken.status).toBe(400);
    expect(broken.body.error.details).toMatchObject({ code: "unterminated-quote", line: "1" });

    const unknown = await set(api.id, "URL=${{nope.URL}}\nDB=${{db.PASWORD}}\n");
    expect(unknown.status).toBe(200);
    expect(unknown.body.diagnostics.map((d: { code: string }) => d.code)).toEqual(["unknown-service", "unknown-variable"]);
    expect(unknown.body.diagnostics[1].fixes[0]).toMatchObject({ kind: "edit", title: "Change to PASSWORD" });
  });

  test("a stale expectedUpdatedAt is a conflict", async () => {
    const { api } = await world();
    const first = await set(api.id, "A=1\n", { expectedUpdatedAt: null });
    expect(first.status).toBe(200);
    const stale = await set(api.id, "A=2\n", { expectedUpdatedAt: null });
    expect(stale.status).toBe(409);
    await Bun.sleep(2);
    const fresh = await set(api.id, "A=3\n", { expectedUpdatedAt: first.body.updatedAt });
    expect(fresh.status).toBe(200);
  });

  test("references give every target's variables with values; the analyzer flags the cross-node ones", async () => {
    const { api, worker, dbId } = await world();
    await callOp(panel, domainOps.addAuto, { serviceId: api.id }, { cookie });
    await set(api.id, "PUBLIC_NAME=shop\n");

    const ctx = await callOp(panel, envOps.references, { serviceId: worker.id }, { cookie });
    expect(ctx.status).toBe(200);
    expect(ctx.body.self).toMatchObject({ serviceId: worker.id, name: "worker", nodes: [{ name: "us-ash-1" }] });
    const apiTarget = ctx.body.targets.find((t: { name: string }) => t.name === "api");
    expect(apiTarget).toMatchObject({
      kind: "service",
      serviceKind: "app",
      exposed: true,
      nodes: [{ name: "de-fsn-1" }],
      internalHost: "api",
    });
    const values = Object.fromEntries(apiTarget.variables.map((v: { name: string; value: string }) => [v.name, v.value]));
    expect(values).toMatchObject({
      URL: "https://api.fsn.example.com",
      DOMAIN: "api.fsn.example.com",
      INTERNAL_URL: "http://api:3000",
      INTERNAL_PORT: "3000",
      PUBLIC_NAME: "shop",
    });
    const dbTarget = ctx.body.targets.find((t: { name: string }) => t.name === "db");
    expect(dbTarget.exposed).toBe(false);
    expect(dbTarget.variables.find((v: { name: string }) => v.name === "PASSWORD")).toMatchObject({ sensitive: true });

    // The editor flow: the references output is the analyzer context.
    const text = "API=${{api.INTERNAL_URL}}\nDB=db:5432\nPUBLIC=${{api.URL}}\n";
    const codes = analyzeEnv(text, ctx.body).diagnostics.map((d) => [d.code, d.range.startLine]);
    expect(codes).toEqual([
      ["internal-reference-other-node", 1],
      ["service-not-exposed", 2],
    ]);
    const saved = await set(worker.id, text);
    expect(saved.body.diagnostics.map((d: { code: string }) => d.code)).toEqual(["internal-reference-other-node", "service-not-exposed"]);
    const analyzed = await callOp(panel, envOps.analyze, { serviceId: worker.id }, { cookie });
    expect(analyzed.body.diagnostics).toEqual(saved.body.diagnostics);
    void dbId;
  });

  test("a service references its own DOMAIN and URL (n8n's N8N_HOST), not its own variables", async () => {
    const { api } = await world();
    await callOp(panel, domainOps.addAuto, { serviceId: api.id }, { cookie });
    const text = "HOST=${{api.DOMAIN}}\nWEBHOOK_URL=${{api.URL}}/hook\nPLAIN=x\nCOPY=${{api.PLAIN}}\n";
    const saved = await set(api.id, text);
    expect(saved.body.diagnostics.map((d: { code: string; range: { startLine: number } }) => [d.code, d.range.startLine])).toEqual([
      ["self-reference", 4],
    ]);
    // The editor's context carries the service's own built-ins, with their values.
    const ctx = await callOp(panel, envOps.references, { serviceId: api.id }, { cookie });
    expect(ctx.body.self.builtins.find((v: { name: string }) => v.name === "DOMAIN")).toMatchObject({ value: "api.fsn.example.com" });
    expect(analyzeEnv(text, ctx.body).diagnostics.map((d) => d.code)).toEqual(["self-reference"]);
    // The deploy gets the real values; its own variables stay as written.
    const env = Object.fromEntries(resolveServiceEnv(panel.deps, api.id).map((v) => [v.name, v.value]));
    expect(env).toMatchObject({
      HOST: "api.fsn.example.com",
      WEBHOOK_URL: "https://api.fsn.example.com/hook",
      COPY: "${{api.PLAIN}}",
    });
  });

  test("members only see values of services they may read", async () => {
    const { api, web, dbId } = await world();
    await set(api.id, "PUBLIC_NAME=shop\n");
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", web.id, ["env.view"]);
    const ctx = await callOp(panel, envOps.references, { serviceId: web.id }, { cookie: member.cookie });
    expect(ctx.status).toBe(200);
    const variable = (target: string, name: string) =>
      ctx.body.targets.find((t: { name: string }) => t.name === target).variables.find((v: { name: string }) => v.name === name);
    // Addresses are visible, other services' own values and database credentials are not.
    expect(variable("api", "INTERNAL_URL").value).toBe("http://api:3000");
    expect(variable("api", "PUBLIC_NAME").value).toBeNull();
    expect(variable("db", "PASSWORD").value).toBeNull();
    expect(variable("db", "INTERNAL_HOST").value).toBe("db");

    grant(panel, member.user.id, "service", dbId, ["databases.credentials"]);
    const again = await callOp(panel, envOps.references, { serviceId: web.id }, { cookie: member.cookie });
    const password = again.body.targets
      .find((t: { name: string }) => t.name === "db")
      .variables.find((v: { name: string }) => v.name === "PASSWORD");
    expect(password.value).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  test("the desired env: shared first, own keys win, references resolved, loops left as written", async () => {
    const { project, api, web, dbId } = await world();
    const shared = await callOp(panel, envOps.setShared, { projectId: project.id, text: "REGION=eu\nLOG_LEVEL=info\n" }, { cookie });
    expect(shared.status).toBe(200);
    await set(api.id, "LOG_LEVEL=debug\nDATABASE_URL=${{db.INTERNAL_URL}}\nWEB=${{web.BACK}}\nSELF='${{api.X}}'\n");
    await set(web.id, "BACK=${{api.WEB}}\n");

    const env = Object.fromEntries(resolveServiceEnv(panel.deps, api.id).map((v) => [v.name, v.value]));
    const conn = await callOp(panel, dbOps.connection, { serviceId: dbId }, { cookie });
    expect(env).toEqual({
      REGION: "eu",
      LOG_LEVEL: "debug",
      DATABASE_URL: conn.body.internal.url,
      // api.WEB -> web.BACK -> api.WEB loops, so it stays as written.
      WEB: "${{web.BACK}}",
      SELF: "${{api.X}}",
    });
    // Secrets are classified: a database credential (and a loop, never guessed public) is secret; plain values are not.
    expect(Object.fromEntries(resolveServiceEnv(panel.deps, api.id).map((v) => [v.name, v.secret]))).toEqual({
      REGION: false,
      LOG_LEVEL: false,
      DATABASE_URL: true,
      WEB: true,
      SELF: false,
    });
    // Databases do not receive shared variables.
    expect(resolveServiceEnv(panel.deps, dbId).map((v) => v.name)).not.toContain("REGION");

    const got = await callOp(panel, envOps.get, { serviceId: api.id }, { cookie });
    expect(got.body.sharedCount).toBe(1);

    // The loop shows up in the editor as a reference-cycle.
    const ctx = await callOp(panel, envOps.references, { serviceId: api.id }, { cookie });
    const back = ctx.body.targets
      .find((t: { name: string }) => t.name === "web")
      .variables.find((v: { name: string }) => v.name === "BACK");
    expect(back).toMatchObject({ value: null, dependsOn: [{ target: "api", variable: "WEB" }] });
    const analyzed = await callOp(panel, envOps.analyze, { serviceId: api.id }, { cookie });
    expect(analyzed.body.diagnostics.map((d: { code: string }) => d.code)).toEqual(["reference-cycle"]);
  });

  test("shared variables: no references, conflicts, and the services still running old values", async () => {
    const { project, api, web, dbId } = await world();
    const first = await callOp(panel, envOps.setShared, { projectId: project.id, text: "A=1\nB=2\n" }, { cookie });
    expect(first.status).toBe(200);
    const row = panel.deps.db.select().from(projectEnv).where(eq(projectEnv.projectId, project.id)).get();
    expect(row?.contentSealed).not.toContain("A=1");
    await set(web.id, "A=override\n");

    const changed = await callOp(
      panel,
      envOps.setShared,
      { projectId: project.id, text: "A=10\nB=2\n", expectedUpdatedAt: first.body.updatedAt },
      { cookie },
    );
    expect(changed.status).toBe(200);
    // web overrides A; the database does not receive shared variables; worker and api do.
    expect(changed.body.affectedServiceIds).toContain(api.id);
    expect(changed.body.affectedServiceIds).not.toContain(web.id);
    expect(changed.body.affectedServiceIds).not.toContain(dbId);

    const stale = await callOp(
      panel,
      envOps.setShared,
      { projectId: project.id, text: "A=3\n", expectedUpdatedAt: first.body.updatedAt },
      { cookie },
    );
    expect(stale.status).toBe(409);
    const withRef = await callOp(panel, envOps.setShared, { projectId: project.id, text: "X=${{api.URL}}\n" }, { cookie });
    expect(withRef.status).toBe(400);

    const got = await callOp(panel, envOps.getShared, { projectId: project.id }, { cookie });
    expect(got.body.variables).toEqual([
      { key: "A", value: "10", line: 1 },
      { key: "B", value: "2", line: 2 },
    ]);
  });
});
