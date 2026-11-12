// A Next.js app built with its Dockerfile failed: the Dockerfile checks
// ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY, but the variable's name has KEY in it
// and its value is token-like, so it was flagged secret, and a Dockerfile
// build gets secret variables only as BuildKit secret files, never as
// build args. Variables with a framework's public prefix are shipped to
// every browser, so they are public: the build request says so, and the
// agent passes them as --build-arg. "# @secret" still makes one a secret.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { services } from "../src/db/schema";
import { resolveBuild } from "../src/modules/deployments/source";
import { writeServiceEnv } from "../src/modules/env/store";
import { loadService } from "../src/modules/services/rows";
import { readSpec } from "../src/modules/services/spec";
import { type TestPanel, testPanel } from "./helpers";
import { seedProject } from "./seed-helpers";

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
