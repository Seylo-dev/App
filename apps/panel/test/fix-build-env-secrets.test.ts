// Every variable used to be flagged secret, so Nixpacks builds (which leave
// secret variables out) got none at all. The flag now says whether a value
// is a secret: its name, its value, a reference to a secret, or a
// "# @public" / "# @secret" comment.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { env as envOps } from "@seylo/ops";
import { resolveServiceEnv } from "../src/modules/env/desired";
import { writeServiceEnv } from "../src/modules/env/store";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

test("public variables reach the build, secrets and references to secrets do not", async () => {
  const { cookie } = await createUser(panel, "owner");
  const node = seedNode(panel);
  const project = seedProject(panel);
  const api = seedService(panel, { projectId: project.id, name: "api", nodeIds: [node.id] });
  const web = seedService(panel, { projectId: project.id, name: "web", nodeIds: [node.id] });
  writeServiceEnv(
    panel.deps.db,
    panel.deps.secrets,
    api.id,
    "SIGNING_TOKEN=abc\nPUBLIC_NAME=shop\nBUILD_ID=Zx81kLq0Pw2mNv7Bc4Rt9Ys6\n",
    null,
  );
  await callOp(panel, envOps.setShared, { projectId: project.id, text: "MODE=production\nSHARED_SECRET=s3\n" }, { cookie });
  writeServiceEnv(
    panel.deps.db,
    panel.deps.secrets,
    web.id,
    [
      "NODE_ENV=production",
      "NEXT_PUBLIC_API_URL=${{api.URL}}",
      "API_INTERNAL=${{api.INTERNAL_URL}}",
      "STRIPE_SECRET_KEY=sk_live_x",
      "FORWARDED=${{api.SIGNING_TOKEN}}",
      "NAME=${{api.PUBLIC_NAME}}",
      "FROM_API=${{api.BUILD_ID}}",
      "DATABASE_URL=postgres://app:hunter2@db:5432/app",
      "RANDOM=Zx81kLq0Pw2mNv7Bc4Rt9Ys6",
      "# @public",
      "NEXT_PUBLIC_ANON_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.Zx81kLq0Pw2mNv7Bc4Rt9Ys6",
      "TITLE=Shop # @secret",
      "",
    ].join("\n"),
    null,
  );
  const flags = Object.fromEntries(resolveServiceEnv(panel.deps, web.id).map((v) => [v.name, v.secret]));
  expect(flags).toEqual({
    MODE: false,
    SHARED_SECRET: true,
    NODE_ENV: false,
    NEXT_PUBLIC_API_URL: false,
    API_INTERNAL: false,
    STRIPE_SECRET_KEY: true,
    FORWARDED: true,
    NAME: false,
    FROM_API: true,
    DATABASE_URL: true,
    RANDOM: true,
    NEXT_PUBLIC_ANON_KEY: false,
    TITLE: true,
  });
});
