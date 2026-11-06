// The env.set reference rule on every other path that writes a service's
// .env: a compose member's environment: and a template's env. A member with
// services.create on the project but no env.view on "payments" cannot read
// payments.STRIPE_KEY by pasting a compose file or template that references
// it; a push to a stack's repo cannot add such a reference either.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { compose, projects, templates } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { services } from "../src/db/schema";
import { planStack } from "../src/modules/compose/plan";
import { assertPushReferences } from "../src/modules/compose/references";
import { readServiceEnv, writeServiceEnv } from "../src/modules/env/store";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedService } from "./seed-helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let nodeA: string;
let projectId: string;
let owner: string;
let environment: Record<string, string>;

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  environment = {};
  fleet.answers.set("parseCompose", () => ({
    projectJson: new TextEncoder().encode(JSON.stringify({ name: "s", services: { web: { image: "nginx:1.27", environment } } })),
    warnings: [],
  }));
  ({ cookie: owner } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie: owner })).body.id;
  const payments = seedService(panel, { projectId, name: "payments", nodeIds: [nodeA] });
  writeServiceEnv(panel.deps.db, panel.deps.secrets, payments.id, "STRIPE_KEY=sk_live_hunter2\n", null);
});
afterEach(() => panel.close());

async function member() {
  const m = await createUser(panel, "member");
  grant(panel, m.user.id, "project", projectId, ["services.create", "services.view", "services.deploy"]);
  return m.cookie;
}

const inline = { type: "inline" as const, yaml: "services:\n  web:\n    image: nginx:1.27\n" };

test("compose: preview, create and update refuse references the caller cannot read", async () => {
  const cookie = await member();
  environment = { LEAK: "${{payments.STRIPE_KEY}}" };
  const preview = await callOp(panel, compose.preview, { projectId, name: "s", nodeId: nodeA, source: inline }, { cookie });
  expect(preview.status).toBe(403);
  expect(preview.body.error.details).toMatchObject({ reference: "payments.STRIPE_KEY", service: "web" });
  const created = await callOp(
    panel,
    compose.create,
    { projectId, name: "s", nodeId: nodeA, source: inline, deployNow: false },
    { cookie },
  );
  expect(created.status).toBe(403);
  expect(panel.deps.db.select().from(services).where(eq(services.name, "s-web")).get()).toBeUndefined();

  // Addresses are not secrets; the stack's own members are the writer's own.
  environment = { API: "${{payments.INTERNAL_URL}}", SELF: "${{s-web.INTERNAL_HOST}}" };
  const ok = await callOp(panel, compose.create, { projectId, name: "s", nodeId: nodeA, source: inline, deployNow: false }, { cookie });
  expect(ok.status).toBe(200);
  const stackId = ok.body.stack.id as string;

  environment = { LEAK: "${{payments.STRIPE_KEY}}" };
  const update = await callOp(panel, compose.update, { serviceId: stackId, source: inline }, { cookie });
  expect(update.status).toBe(403);
  const dry = await callOp(panel, compose.update, { serviceId: stackId, source: inline, dryRun: true }, { cookie });
  expect(dry.status).toBe(403);
  const web = panel.deps.db.select().from(services).where(eq(services.name, "s-web")).get();
  expect(readServiceEnv(panel.deps.db, panel.deps.secrets, web?.id as string).text).not.toContain("STRIPE_KEY");

  // The owner may.
  expect((await callOp(panel, compose.update, { serviceId: stackId, source: inline, dryRun: true }, { cookie: owner })).status).toBe(200);
});

test("compose: a push cannot add a reference outside the stack", async () => {
  environment = { API: "${{payments.INTERNAL_URL}}" };
  const ok = await callOp(
    panel,
    compose.create,
    { projectId, name: "s", nodeId: nodeA, source: inline, deployNow: false },
    { cookie: owner },
  );
  const stack = panel.deps.db.select().from(services).where(eq(services.id, ok.body.stack.id)).get();
  if (!stack) throw new Error("no stack");
  const plan = (env: Record<string, string>) => planStack("s", { services: { web: { image: "nginx:1.27", environment: env } } }, inline);
  // Addresses and references the member already had are fine.
  assertPushReferences(panel.deps, stack, plan({ API: "${{payments.INTERNAL_URL}}", HOST: "${{payments.INTERNAL_HOST}}" }));
  expect(() => assertPushReferences(panel.deps, stack, plan({ LEAK: "${{payments.STRIPE_KEY}}" }))).toThrow(
    "Apply this change from the panel",
  );
});

test("templates refuse env references the caller cannot read", async () => {
  const meta = `name: "Leaky"
description: "x"
category: "Other"
schema:
  type: object
  properties: {}
`;
  const source = (env: string) => `export function generate(input: { serviceName: string }) {
  return { services: [{ type: "app", data: { serviceName: input.serviceName, source: { type: "image", image: "nginx:1.27" }, env: ${JSON.stringify(env)} } }] };
}`;
  expect(
    (
      await callOp(
        panel,
        templates.saveCustom,
        { slug: "leaky", metaYaml: meta, source: source("LEAK=${{payments.STRIPE_KEY}}") },
        { cookie: owner },
      )
    ).status,
  ).toBe(200);
  const cookie = await member();
  const res = await callOp(
    panel,
    templates.create,
    { projectId, slug: "leaky", name: "app", nodeId: nodeA, values: {}, deployNow: false },
    { cookie },
  );
  expect(res.status).toBe(403);
  expect(res.body.error.details).toMatchObject({ reference: "payments.STRIPE_KEY", service: "app" });
  expect(panel.deps.db.select().from(services).where(eq(services.name, "app")).get()).toBeUndefined();

  await callOp(
    panel,
    templates.saveCustom,
    { slug: "leaky", metaYaml: meta, source: source("API=${{payments.INTERNAL_URL}}\nME=${{app.INTERNAL_HOST}}") },
    {
      cookie: owner,
    },
  );
  const ok = await callOp(
    panel,
    templates.create,
    { projectId, slug: "leaky", name: "app", nodeId: nodeA, values: {}, deployNow: false },
    { cookie },
  );
  expect(ok.status).toBe(200);
});
