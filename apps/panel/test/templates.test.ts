// Templates on the panel: listing, previewing and installing catalog
// templates, and custom ones. The catalog is the fixture repository
// (fixtures/catalog: flows = app + Postgres with references, metrics = a file
// mount and a command, board = a required field and a select), so these
// tests do not depend on the real catalog; that one is checked as a whole
// by vendored-catalog.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { projects, templates } from "@seylo/ops";
import { DeployStage } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { deployments, domains, nodes, serviceDatabases, services, volumes } from "../src/db/schema";
import { readServiceEnv } from "../src/modules/env/store";
import { serviceSpecFor } from "../src/modules/services/desired";
import { resetCatalogs, useFixtureBundle } from "./catalog-fakes";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let nodeA: string;

beforeAll(() => useFixtureBundle());
afterAll(resetCatalogs);
beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  panel.deps.db.update(nodes).set({ wildcardDomain: "n1.example.com" }).where(eq(nodes.id, nodeA)).run();
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "apps" }, { cookie })).body.id;
});
afterEach(() => panel.close());

describe("template catalog", () => {
  test("lists templates with forms and categories, filtered by text and category", async () => {
    const res = await callOp(panel, templates.list, {}, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.templates.map((t: { slug: string }) => t.slug)).toEqual(["board", "flows", "metrics"]);
    expect(res.body.categories).toEqual(["Automation", "Monitoring", "Productivity"]);
    expect(res.body.templates[1]).toMatchObject({ slug: "flows", builtIn: true, catalog: "official", unsigned: false });
    const filtered = await callOp(panel, templates.list, { query: "postgres" }, { cookie });
    expect(filtered.body.templates.map((t: { slug: string }) => t.slug)).toEqual(["flows", "metrics"]);
    const monitoring = await callOp(panel, templates.list, { category: "Monitoring" }, { cookie });
    expect(monitoring.body.templates.map((t: { slug: string }) => t.slug)).toEqual(["metrics"]);
    const flows = await callOp(panel, templates.get, { slug: "flows" }, { cookie });
    expect(flows.body).toMatchObject({ name: "Flows", builtIn: true, catalog: "official", creates: "App + Postgres" });
    expect(flows.body.fields.map((f: { key: string }) => f.key)).toEqual(["image", "timezone"]);
    expect((await callOp(panel, templates.get, { slug: "nope" }, { cookie })).status).toBe(404);
    const files = await callOp(panel, templates.source, { slug: "flows" }, { cookie });
    expect(files.body.builtIn).toBe(true);
    expect(files.body.source).toContain("export function generate");
    expect(files.body.metaYaml).toContain('name: "Flows"');
  });
});

describe("installing a template", () => {
  test("flows: a Postgres database and an app wired with references and an automatic domain", async () => {
    const preview = await callOp(
      panel,
      templates.preview,
      { projectId, slug: "flows", name: "flows", nodeId: nodeA, values: {} },
      { cookie },
    );
    expect(preview.body.services.map((s: { name: string; kind: string }) => [s.name, s.kind])).toEqual([
      ["flows-db", "postgres"],
      ["flows", "app"],
    ]);
    const app = preview.body.services[1];
    expect(app).toMatchObject({
      image: "example/flows:1.4.2",
      ports: [5678],
      internalOnly: false,
      domains: ["flows.n1.example.com"],
      volumes: [{ name: "data", mountPath: "/home/app/.flows" }],
    });
    expect(app.envKeys).toContain("ENCRYPTION_KEY");
    // Preview never echoes generated values.
    expect(JSON.stringify(preview.body)).not.toMatch(/[0-9a-f]{64}/);

    const created = await callOp(
      panel,
      templates.create,
      { projectId, slug: "flows", name: "flows", nodeId: nodeA, values: { timezone: "Europe/Berlin" } },
      { cookie },
    );
    expect(created.status).toBe(200);
    for (const s of created.body.services) expect(s.templateSlug).toBe("flows");
    await fleet.settle();
    const appRow = panel.deps.db.select().from(services).where(eq(services.name, "flows")).get();
    const env = readServiceEnv(panel.deps.db, panel.deps.secrets, appRow?.id as string).text;
    expect(env).toContain("DB_PASSWORD=${{flows-db.PASSWORD}}");
    expect(env).toContain("TIMEZONE=Europe/Berlin");
    expect(env).toMatch(/ENCRYPTION_KEY=[0-9a-f]{64}/);
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
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, appRow?.id as string, nodeA)?.image?.reference).toBe("example/flows:1.4.2");

    const again = await callOp(panel, templates.create, { projectId, slug: "flows", name: "flows", nodeId: nodeA, values: {} }, { cookie });
    expect(again.body.error.code).toBe("CONFLICT");
    expect(panel.deps.db.select().from(services).all()).toHaveLength(2);
  });

  test("file mounts are sealed and commands replace the entrypoint", async () => {
    const res = await callOp(
      panel,
      templates.create,
      { projectId, slug: "metrics", name: "prom", nodeId: nodeA, values: { retention: "30d" } },
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

  test("required fields and selects are checked; an image pinned by digest installs", async () => {
    const missing = await callOp(
      panel,
      templates.preview,
      { projectId, slug: "board", name: "pad", nodeId: nodeA, values: {} },
      { cookie },
    );
    expect(missing.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "values.email" } });
    const badPlan = await callOp(
      panel,
      templates.preview,
      { projectId, slug: "board", name: "pad", nodeId: nodeA, values: { email: "a@example.com", plan: "huge" } },
      { cookie },
    );
    expect(badPlan.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "values.plan" } });
    const created = await callOp(
      panel,
      templates.create,
      { projectId, slug: "board", name: "pad", nodeId: nodeA, values: { email: "a@example.com", plan: "large" } },
      { cookie },
    );
    expect(created.status).toBe(200);
    await fleet.settle();
    const env = readServiceEnv(panel.deps.db, panel.deps.secrets, created.body.services[0].id).text;
    expect(env).toContain("PLAN=large");
    expect(env).toMatch(/ADMIN_PASSWORD=[A-Za-z0-9]{32}/);
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
    const catalogSlug = await callOp(panel, templates.saveCustom, { slug: "flows", metaYaml: meta, source: code }, { cookie });
    expect(catalogSlug.body.error.code).toBe("CONFLICT");

    const saved = await callOp(panel, templates.saveCustom, { slug: "hello", metaYaml: meta, source: code }, { cookie });
    expect(saved.body).toMatchObject({ slug: "hello", name: "Hello", builtIn: false, catalog: "custom", unsigned: false });
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

  test("a required email field without a default gets an email address in the dry run", async () => {
    const withEmail = `name: "Mailer"
description: "Checks its email."
schema:
  type: object
  required: ["adminEmail"]
  properties:
    adminEmail:
      type: "string"
`;
    const strict = `export function generate(input: { serviceName: string; adminEmail: string }) {
  if (!input.adminEmail.includes("@")) throw new Error("adminEmail must be an email address");
  return { services: [{ type: "app", data: { serviceName: input.serviceName, source: { type: "image", image: "nginx:1.27" } } }] };
}`;
    const saved = await callOp(panel, templates.saveCustom, { slug: "mailer", metaYaml: withEmail, source: strict }, { cookie });
    expect(saved.status).toBe(200);
  });
});

describe("template databases", () => {
  test("a template can ask for an engine variant (pgvector) and the new engines", async () => {
    const meta = `name: "Vectors"
description: "An app with a vector store."
category: "Other"
schema:
  type: object
  properties: {}
`;
    const code = `export function generate(input: { serviceName: string }) {
  return { services: [
    { type: "postgres", data: { serviceName: input.serviceName + "-db", variant: "pgvector", version: "17" } },
    { type: "app", data: { serviceName: input.serviceName, source: { type: "image", image: "nginx:1.27" }, env: "DB=\${{" + input.serviceName + "-db.INTERNAL_URL}}" } },
  ] };
}`;
    expect((await callOp(panel, templates.saveCustom, { slug: "vectors", metaYaml: meta, source: code }, { cookie })).status).toBe(200);
    const preview = await callOp(
      panel,
      templates.preview,
      { projectId, slug: "vectors", name: "vec", nodeId: nodeA, values: {} },
      { cookie },
    );
    expect(preview.body.services[0]).toMatchObject({ name: "vec-db", kind: "postgres", image: "postgres (pgvector) 17" });
    const created = await callOp(
      panel,
      templates.create,
      { projectId, slug: "vectors", name: "vec", nodeId: nodeA, values: {} },
      { cookie },
    );
    expect(created.status).toBe(200);
    const db = panel.deps.db.select().from(serviceDatabases).all();
    expect(db.map((d) => [d.engine, d.variant, d.version])).toEqual([["postgres", "pgvector", "17"]]);

    // The output schema takes the new engine names (installing them needs a node that runs them).
    const ch = code.replace(
      'type: "postgres", data: { serviceName: input.serviceName + "-db", variant: "pgvector", version: "17" }',
      'type: "clickhouse", data: { serviceName: input.serviceName + "-db" }',
    );
    expect((await callOp(panel, templates.saveCustom, { slug: "events", metaYaml: meta, source: ch }, { cookie })).status).toBe(200);
    const chPreview = await callOp(
      panel,
      templates.preview,
      { projectId, slug: "events", name: "ev", nodeId: nodeA, values: {} },
      { cookie },
    );
    expect(chPreview.body.services[0]).toMatchObject({ name: "ev-db", kind: "clickhouse" });
  });
});
