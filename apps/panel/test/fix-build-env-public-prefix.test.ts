// A Next.js app built with its Dockerfile failed: the Dockerfile checks
// ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY, but the variable's name has KEY in it
// and its value is token-like, so it was flagged secret, and a Dockerfile
// build gets secret variables only as BuildKit secret files, never as
// build args. Variables with a framework's public prefix are shipped to
// every browser, so they are public: the build request says so, and the
// agent passes them as --build-arg. "# @secret" still makes one a secret.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { classifyEntries, parseEnv } from "@seylo/env-analyzer";
import { env as envOps } from "@seylo/ops";
import { services } from "../src/db/schema";
import { resolveBuild } from "../src/modules/deployments/source";
import { resolveServiceEnv } from "../src/modules/env/desired";
import { readServiceEnv, writeServiceEnv } from "../src/modules/env/store";
import { loadService } from "../src/modules/services/rows";
import { readSpec } from "../src/modules/services/spec";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

// Fake keys, joined at runtime so secret scanners don't flag the fixture.
const siteKey = ["0x4AAAAAAA", "Bc3dEf5gH7jK9mN1pQ"].join("");

test("a NEXT_PUBLIC_..._KEY variable is a build arg of a Dockerfile build, a secret one is not", async () => {
  const project = seedProject(panel);
  const row = panel.deps.db
    .insert(services)
    .values({
      projectId: project.id,
      name: "web",
      nameKey: "web",
      kind: "app",
      spec: {
        source: { type: "upload", fileName: "web.tar.gz" },
        build: { builder: "dockerfile", dockerfilePath: "Dockerfile" },
        ports: [{ containerPort: 3000, protocol: "tcp" }],
      },
    })
    .returning()
    .get();
  writeServiceEnv(
    panel.deps.db,
    panel.deps.secrets,
    row.id,
    [
      "NEXT_PUBLIC_API_URL=https://api.example.com",
      "NEXT_PUBLIC_WEB_URL=https://example.com",
      `NEXT_PUBLIC_TURNSTILE_SITE_KEY=${siteKey}`,
      `VITE_MAPS_KEY=${siteKey}`,
      `TURNSTILE_SECRET_KEY=${siteKey}`,
      "# @secret",
      "NEXT_PUBLIC_PREVIEW_TOKEN=abc",
      "",
    ].join("\n"),
    null,
  );
  const service = loadService(panel.deps.db, row.id);
  const resolved = await resolveBuild(panel.deps, {
    service,
    spec: readSpec(service.spec),
    buildId: "b1",
    generation: 1,
    commitSha: null,
    uploadId: "u1",
  });
  expect(resolved.builderLabel).toBe("Dockerfile");
  const flags = Object.fromEntries(resolved.request.env.map((v) => [v.name, v.secret]));
  expect(flags).toMatchObject({
    NEXT_PUBLIC_API_URL: false,
    NEXT_PUBLIC_WEB_URL: false,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: false,
    VITE_MAPS_KEY: false,
    TURNSTILE_SECRET_KEY: true,
    NEXT_PUBLIC_PREVIEW_TOKEN: true,
  });
  expect(resolved.request.env.find((v) => v.name === "NEXT_PUBLIC_TURNSTILE_SITE_KEY")?.value).toBe(siteKey);
});

// PUBLIC_ is also a plain word outside SvelteKit and Astro ("PUBLIC_DATABASE_URL", the outside
// address). A password under a public prefix stays a secret: a URL with one, a reference to a
// database's PASSWORD or connection URL, or to a variable that holds one. Otherwise Nixpacks would
// bake it into the image, a Dockerfile build would get it as a build arg and crash reports would
// show it. A secret that is no database credential (a key kept in a shared variable) does not.
test("a password under a public prefix stays a secret, another secret reference does not", async () => {
  const { cookie } = await createUser(panel, "owner");
  const node = seedNode(panel);
  const project = seedProject(panel);
  seedService(panel, { projectId: project.id, name: "db", kind: "postgres", nodeIds: [node.id] });
  const api = seedService(panel, { projectId: project.id, name: "api", nodeIds: [node.id] });
  const web = seedService(panel, { projectId: project.id, name: "web", nodeIds: [node.id] });
  writeServiceEnv(
    panel.deps.db,
    panel.deps.secrets,
    api.id,
    "DB_PASS=${{db.PASSWORD}}\nDB_LINK=postgres://app:hunter2@db:5432/app\nSITE_TOKEN=abc\n",
    null,
  );
  await callOp(panel, envOps.setShared, { projectId: project.id, text: `TURNSTILE_SITE_KEY=${siteKey}\n` }, { cookie });
  writeServiceEnv(
    panel.deps.db,
    panel.deps.secrets,
    web.id,
    [
      "PUBLIC_DATABASE_URL=postgres://user:pass@db.example.com:5432/app",
      "PUBLIC_DB_URL=${{db.INTERNAL_URL}}",
      "NEXT_PUBLIC_X=${{db.PASSWORD}}",
      "VITE_CHAIN=${{api.DB_PASS}}",
      "NEXT_PUBLIC_LINK=${{api.DB_LINK}}",
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY=${{project.TURNSTILE_SITE_KEY}}",
      "NEXT_PUBLIC_SITE_TOKEN=${{api.SITE_TOKEN}}",
      "PUBLIC_DB_HOST=${{db.INTERNAL_HOST}}",
      "# @public",
      "PUBLIC_DEMO_URL=postgres://demo:demo@demo.example.com/demo",
      "",
    ].join("\n"),
    null,
  );
  const flags = Object.fromEntries(resolveServiceEnv(panel.deps, web.id).map((v) => [v.name, v.secret]));
  expect(flags).toMatchObject({
    PUBLIC_DATABASE_URL: true,
    PUBLIC_DB_URL: true,
    NEXT_PUBLIC_X: true,
    VITE_CHAIN: true,
    NEXT_PUBLIC_LINK: true,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: false,
    NEXT_PUBLIC_SITE_TOKEN: false,
    PUBLIC_DB_HOST: false,
    PUBLIC_DEMO_URL: false,
  });

  // The editor's Secret chips agree: api's DB_PASS references a credential, so the context says
  // what it depends on and classifyEntries follows it.
  const refs = await callOp(panel, envOps.references, { serviceId: web.id }, { cookie });
  expect(refs.status).toBe(200);
  const text = readServiceEnv(panel.deps.db, panel.deps.secrets, web.id).text;
  const parsed = parseEnv(text);
  const verdicts = Object.fromEntries(classifyEntries(parsed, refs.body).map((v, i) => [parsed.entries[i]?.key, v.secret]));
  // flags also holds the shared variables the service receives.
  expect(flags).toMatchObject(verdicts);
  expect(Object.keys(verdicts)).toHaveLength(9);
});
