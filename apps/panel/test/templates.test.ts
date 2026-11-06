import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { projects, templates } from "@seylo/ops";
import { DeployStage } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { deployments, domains, nodes, services, volumes } from "../src/db/schema";
import { readServiceEnv } from "../src/modules/env/store";
import { serviceSpecFor } from "../src/modules/services/desired";
import { builtInTemplates } from "../src/modules/templates/catalog";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let nodeA: string;

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  panel.deps.db.update(nodes).set({ wildcardDomain: "n1.example.com" }).where(eq(nodes.id, nodeA)).run();
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "apps" }, { cookie })).body.id;
});
afterEach(() => panel.close());

/** Values for the required fields that have no default. */
function requiredValues(slug: string): Record<string, string> {
  const detail = builtInTemplates().get(slug)?.detail;
  const out: Record<string, string> = {};
  for (const f of detail?.fields ?? [])
    if (f.required && f.default === null) out[f.key] = f.key.toLowerCase().includes("email") ? "owner@example.com" : "value";
  return out;
}

describe("template catalog", () => {
  test("ships at least 20 templates with forms and categories", async () => {
    const res = await callOp(panel, templates.list, {}, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.templates.length).toBeGreaterThanOrEqual(20);
    expect(res.body.categories).toContain("Monitoring");
    const filtered = await callOp(panel, templates.list, { query: "postgres" }, { cookie });
    expect(filtered.body.templates.map((t: { slug: string }) => t.slug)).toContain("pgadmin");
    const n8n = await callOp(panel, templates.get, { slug: "n8n" }, { cookie });
    expect(n8n.body).toMatchObject({ name: "n8n", builtIn: true, creates: "App + Postgres" });
    expect(n8n.body.fields.map((f: { key: string }) => f.key)).toEqual(["image", "timezone"]);
    expect((await callOp(panel, templates.get, { slug: "nope" }, { cookie })).status).toBe(404);
  });

  test("every template runs in the sandbox and previews valid services", async () => {
    const slugs = [...builtInTemplates().keys()];
    expect(slugs.length).toBeGreaterThanOrEqual(20);
    for (const slug of slugs) {
      const res = await callOp(
        panel,
        templates.preview,
        { projectId, slug, name: "app", nodeId: nodeA, values: requiredValues(slug) },
        { cookie },
      );
      if (res.status !== 200) throw new Error(`${slug}: ${JSON.stringify(res.body)}`);
      expect(res.body.services.length).toBeGreaterThan(0);
      for (const s of res.body.services) {
        expect(s.name.startsWith("app")).toBe(true);
        expect(s.conflict).toBe(false);
      }
      const app = res.body.services.find((s: { kind: string }) => s.kind === "app");
      expect(app.image).toMatch(/:[\w.-]+$/);
    }
  });

  test("every template installs: services, databases, env, volumes and domains", async () => {
    for (const slug of builtInTemplates().keys()) {
      const project = (await callOp(panel, projects.create, { name: `p-${slug}` }, { cookie })).body.id;
      const res = await callOp(
        panel,
        templates.create,
        { projectId: project, slug, name: "app", nodeId: nodeA, values: requiredValues(slug) },
        { cookie },
      );
      if (res.status !== 200) throw new Error(`${slug}: ${JSON.stringify(res.body)}`);
      for (const s of res.body.services) expect(s.templateSlug).toBe(slug);
    }
    await fleet.settle();
  });
});

describe("installing a template", () => {
  test("n8n: a Postgres database and an app wired with references and an automatic domain", async () => {
    const preview = await callOp(
      panel,
      templates.preview,
      { projectId, slug: "n8n", name: "flows", nodeId: nodeA, values: {} },
      { cookie },
    );
    expect(preview.body.services.map((s: { name: string; kind: string }) => [s.name, s.kind])).toEqual([
      ["flows-db", "postgres"],
      ["flows", "app"],
    ]);
    const app = preview.body.services[1];
    expect(app).toMatchObject({
      image: "n8nio/n8n:1.80.0",
      ports: [5678],
      internalOnly: false,
      domains: ["flows.n1.example.com"],
      volumes: [{ name: "data", mountPath: "/home/node/.n8n" }],
    });
    expect(app.envKeys).toContain("N8N_ENCRYPTION_KEY");
    // Preview never echoes generated values.
    expect(JSON.stringify(preview.body)).not.toMatch(/[0-9a-f]{64}/);

    const created = await callOp(
      panel,
      templates.create,
      { projectId, slug: "n8n", name: "flows", nodeId: nodeA, values: { timezone: "Europe/Berlin" } },
      { cookie },
    );
    expect(created.status).toBe(200);
    await fleet.settle();
    const appRow = panel.deps.db.select().from(services).where(eq(services.name, "flows")).get();
    const env = readServiceEnv(panel.deps.db, panel.deps.secrets, appRow?.id as string).text;
    expect(env).toContain("DB_POSTGRESDB_PASSWORD=${{flows-db.PASSWORD}}");
    expect(env).toContain("GENERIC_TIMEZONE=Europe/Berlin");
    expect(env).toMatch(/N8N_ENCRYPTION_KEY=[0-9a-f]{64}/);
    expect(
      panel.deps.db
        .select()
        .from(domains)
        .where(eq(domains.serviceId, appRow?.id as string))
        .all()
        .map((d) => d.host),
    ).toEqual(["flows.n1.example.com"]);
    // The app waits for its database before it rolls out.
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, appRow?.id as string, nodeA)).toBeNull();
    const dbRow = panel.deps.db.select().from(services).where(eq(services.name, "flows-db")).get();
    const dbDeploy = panel.deps.db
      .select()
      .from(deployments)
      .where(eq(deployments.serviceId, dbRow?.id as string))
      .get();
    fleet.deployProgress(nodeA, dbRow?.id as string, dbDeploy?.generation as number, DeployStage.SUCCEEDED);
    await fleet.settle();
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, appRow?.id as string, nodeA)?.image?.reference).toBe("n8nio/n8n:1.80.0");

    const again = await callOp(panel, templates.create, { projectId, slug: "n8n", name: "flows", nodeId: nodeA, values: {} }, { cookie });
    expect(again.body.error.code).toBe("CONFLICT");
    expect(panel.deps.db.select().from(services).all()).toHaveLength(2);
  });

  test("file mounts are sealed and commands replace the entrypoint", async () => {
    const res = await callOp(
      panel,
      templates.create,
      { projectId, slug: "prometheus", name: "prom", nodeId: nodeA, values: { retention: "30d" } },
      { cookie },
    );
    expect(res.status).toBe(200);
    await fleet.settle();
    const id = res.body.services[0].id;
    const file = panel.deps.db.select().from(volumes).where(eq(volumes.kind, "file")).get();
    expect(file?.contentSealed).not.toContain("scrape_configs");
    const spec = serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA);
    expect(spec?.container?.entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(spec?.container?.command[0]).toContain("--storage.tsdb.retention.time=30d");
    expect(new TextDecoder().decode(spec?.files[0]?.content)).toContain("scrape_configs");
  });

  test("required fields and selects are checked", async () => {
    const res = await callOp(panel, templates.preview, { projectId, slug: "pgadmin", name: "pga", nodeId: nodeA, values: {} }, { cookie });
    expect(res.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "values.email" } });
  });
});

describe("custom templates", () => {
  const meta = `name: "Hello"
description: "A static page."
category: "Other"
schema:
  type: object
  required: ["image"]
  properties:
    image:
      type: "string"
      default: "nginx:1.27"
`;
  const code = `import { PRIMARY_DOMAIN } from "~templates-utils";
export function generate(input: { serviceName: string; image: string }) {
  return { services: [{ type: "app", data: { serviceName: input.serviceName, source: { type: "image", image: input.image }, domains: [{ host: PRIMARY_DOMAIN, port: 80 }] } }] };
}`;

  test("are checked in the sandbox, listed, installed and deleted", async () => {
    const broken = await callOp(
      panel,
      templates.saveCustom,
      { slug: "hello", metaYaml: meta, source: "export function generate() { return {}; }" },
      { cookie },
    );
    expect(broken.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "source" } });
    const builtIn = await callOp(panel, templates.saveCustom, { slug: "n8n", metaYaml: meta, source: code }, { cookie });
    expect(builtIn.body.error.code).toBe("CONFLICT");

    const saved = await callOp(panel, templates.saveCustom, { slug: "hello", metaYaml: meta, source: code }, { cookie });
    expect(saved.body).toMatchObject({ slug: "hello", name: "Hello", builtIn: false });
    const list = await callOp(panel, templates.list, { query: "hello" }, { cookie });
    expect(list.body.templates.map((t: { slug: string; builtIn: boolean }) => [t.slug, t.builtIn])).toEqual([["hello", false]]);
    const files = await callOp(panel, templates.source, { slug: "hello" }, { cookie });
    expect(files.body).toEqual({ metaYaml: meta, source: code, builtIn: false });
    const created = await callOp(panel, templates.create, { projectId, slug: "hello", name: "hi", nodeId: nodeA, values: {} }, { cookie });
    expect(created.body.services[0]).toMatchObject({ name: "hi", templateSlug: "hello" });

    const { cookie: memberCookie } = await createUser(panel, "member");
    expect((await callOp(panel, templates.deleteCustom, { slug: "hello" }, { cookie: memberCookie })).status).toBe(403);
    expect((await callOp(panel, templates.deleteCustom, { slug: "hello" }, { cookie })).status).toBe(200);
    expect((await callOp(panel, templates.get, { slug: "hello" }, { cookie })).status).toBe(404);
  });
});
