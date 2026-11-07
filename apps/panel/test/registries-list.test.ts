// registries.list for people who do not manage registries: names and
// servers only, and an answer that matches the op's own output schema (a
// blanked user name used to fail the output check and answer 500).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { projects, registries } from "@seylo/ops";
import { registryCredentials } from "../src/db/schema";
import { callOp, createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;

beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

function saveLogin() {
  panel.deps.db
    .insert(registryCredentials)
    .values({
      name: "GHCR",
      server: "ghcr.io",
      username: "acme-bot",
      passwordSealed: panel.deps.secrets.seal("ghp_x", "registry.credential"),
    })
    .run();
}

test("a member with a project grant lists logins without user names", async () => {
  const owner = await createUser(panel, "owner");
  const projectId = (await callOp(panel, projects.create, { name: "apps" }, { cookie: owner.cookie })).body.id as string;
  saveLogin();
  const member = await createUser(panel, "member");
  grant(panel, member.user.id, "project", projectId, ["services.create", "services.view"]);

  const asMember = await callOp(panel, registries.list, {}, { cookie: member.cookie });
  expect(asMember.status).toBe(200);
  expect(asMember.body.registries).toHaveLength(1);
  expect(asMember.body.registries[0]).toMatchObject({ name: "GHCR", server: "ghcr.io", username: null });

  const key = createApiKey(panel, member.user.id, { readOnly: true });
  const asKey = await callOp(panel, registries.list, {}, { bearer: key });
  expect(asKey.status).toBe(200);
  expect(asKey.body.registries[0].username).toBeNull();

  const asOwner = await callOp(panel, registries.list, {}, { cookie: owner.cookie });
  expect(asOwner.body.registries[0].username).toBe("acme-bot");
});
