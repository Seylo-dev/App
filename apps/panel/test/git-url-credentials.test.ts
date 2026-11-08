// A token in a git URL (https://x-access-token:<pat>@host/...) is refused
// everywhere a git URL is taken, before it reaches the service spec or the
// audit log, with a message that points at git credentials. Sources saved
// before the rule never show one again.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { boxes as boxOps, compose, GitUrl, git, HttpsGitUrl, projects, services as serviceOps } from "@seylo/ops";
import { Value } from "@sinclair/typebox/value";
import { eq } from "drizzle-orm";
import { auditLog, serviceBoxes, services } from "../src/db/schema";
import { withoutCredentials } from "../src/modules/services/git-url";
import { readSpec } from "../src/modules/services/spec";
import { createUser, grant, type TestPanel, testPanel } from "./helpers";
import { call } from "./people-helpers";
import { seedNode, seedService } from "./seed-helpers";

const token = "ghp_TopSecretToken123";
const withToken = `https://x-access-token:${token}@github.com/acme/site.git`;

let panel: TestPanel;
let cookie: string;
let projectId: string;
let nodeId: string;

beforeEach(async () => {
  panel = testPanel();
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await call(panel, projects.create, { name: "apps" }, { cookie })).body.id;
  nodeId = seedNode(panel).id;
});
afterEach(() => panel.close());

function expectRefused(result: { status: number; body: { error?: { message: string; details?: { field?: string } } } }, field: string) {
  expect(result.status).toBe(400);
  expect(result.body.error?.details?.field).toBe(field);
  expect(result.body.error?.message).toContain("git credential");
}

describe("a git URL with a user name, token or password", () => {
  test("is refused by services.create, services.setSource, compose.preview and git.branches", async () => {
    const source = { type: "git", url: withToken, branch: "main", credentialId: null, deployOnPush: false } as const;
    expectRefused(await call(panel, serviceOps.create, { projectId, name: "site", kind: "app", nodeId, source }, { cookie }), "source.url");

    const existing = seedService(panel, { projectId, name: "web", nodeIds: [nodeId] });
    expectRefused(await call(panel, serviceOps.setSource, { serviceId: existing.id, source }, { cookie }), "source.url");

    const stack = { type: "git", url: withToken, branch: "main", path: "compose.yaml", credentialId: null, deployOnPush: false } as const;
    expectRefused(await call(panel, compose.preview, { projectId, name: "stack", nodeId, source: stack }, { cookie }), "source.url");

    expectRefused(await call(panel, git.branches, { projectId, url: withToken }, { cookie }), "url");

    // Nothing kept the token: not the services, not the audit log of the refused attempts.
    expect(JSON.stringify(panel.deps.db.select().from(services).all())).not.toContain(token);
    expect(JSON.stringify(panel.deps.db.select().from(auditLog).all())).not.toContain(token);
  });

  test("the schema refuses userinfo in https and passwords in ssh, and keeps ssh users", () => {
    const ok = [
      "https://github.com/acme/site.git",
      "https://git.example.com:8443/team/app.git",
      "https://github.com/acme/site@v2.git",
      "ssh://git@github.com/acme/site.git",
      "ssh://git@git.example.com:2222/acme/site.git",
      "git@github.com:acme/site.git",
    ];
    const refused = [withToken, "https://ghp_x@github.com/a/b.git", "https://user:@github.com/a/b.git", "ssh://git:hunter2@host/a/b.git"];
    for (const url of ok) expect({ url, ok: Value.Check(GitUrl, url) }).toEqual({ url, ok: true });
    for (const url of refused) expect({ url, ok: Value.Check(GitUrl, url) }).toEqual({ url, ok: false });
  });
});

test("a source saved with a token before the rule is shown without it", async () => {
  const legacy = seedService(panel, { projectId, name: "old", nodeIds: [nodeId] });
  const row = panel.deps.db.select().from(services).where(eq(services.id, legacy.id)).get();
  panel.deps.db
    .update(services)
    .set({
      spec: { ...(row?.spec as object), source: { type: "git", url: withToken, branch: "main", credentialId: null, deployOnPush: false } },
    })
    .where(eq(services.id, legacy.id))
    .run();
  // Deploys still read it: only answers drop the token.
  const stored = panel.deps.db.select().from(services).where(eq(services.id, legacy.id)).get();
  expect(readSpec(stored?.spec).source).toMatchObject({ type: "git", url: withToken });
  const detail = await call(panel, serviceOps.get, { serviceId: legacy.id }, { cookie });
  expect(detail.status).toBe(200);
  expect(detail.body.sourceConfig.url).toBe("https://github.com/acme/site.git");
  expect(JSON.stringify(detail.body)).not.toContain(token);

  expect(withoutCredentials("ssh://git:hunter2@host/a.git")).toBe("ssh://git@host/a.git");
  expect(withoutCredentials("ssh://git@host/a.git")).toBe("ssh://git@host/a.git");
  expect(withoutCredentials("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
});

describe("a Box repository URL", () => {
  test("with a user name or token is refused by boxes.create and never stored or audited", async () => {
    const member = await createUser(panel, "member");
    // A Box starts right away, so creating one also needs services.deploy (create-rights.ts).
    grant(panel, member.user.id, "project", projectId, ["services.create", "services.deploy", "services.view"]);
    const refused = await call(panel, boxOps.create, { projectId, name: "dev", nodeId, repository: withToken }, { cookie: member.cookie });
    expect(refused.status).toBe(400);
    expect(refused.body.error?.details?.field).toBe("repository");
    expect(refused.body.error?.message).toContain("user name or token");
    expect(JSON.stringify(panel.deps.db.select().from(serviceBoxes).all())).not.toContain(token);
    expect(JSON.stringify(panel.deps.db.select().from(auditLog).all())).not.toContain(token);

    const created = await call(
      panel,
      boxOps.create,
      { projectId, name: "dev", nodeId, repository: "https://github.com/acme/site.git" },
      { cookie: member.cookie },
    );
    expect(created.status).toBe(200);
    expect(created.body.repository).toBe("https://github.com/acme/site.git");
    for (const url of ["https://github.com/acme/site.git", "https://git.example.com:8443/a/b"])
      expect(Value.Check(HttpsGitUrl, url)).toBe(true);
    for (const url of [withToken, "https://ghp_x@github.com/a/b.git", "ssh://git@github.com/a/b.git", "http://github.com/a/b.git"])
      expect(Value.Check(HttpsGitUrl, url)).toBe(false);
  });

  test("saved with a token before the rule is shown and cloned without it", async () => {
    const box = await call(panel, boxOps.create, { projectId, name: "old", nodeId }, { cookie });
    const serviceId = box.body.serviceId as string;
    panel.deps.db.update(serviceBoxes).set({ repository: withToken }).where(eq(serviceBoxes.serviceId, serviceId)).run();
    const viewer = await createUser(panel, "member");
    grant(panel, viewer.user.id, "project", projectId, ["services.view"]);
    const got = await call(panel, boxOps.get, { serviceId }, { cookie: viewer.cookie });
    expect(got.status).toBe(200);
    expect(got.body.repository).toBe("https://github.com/acme/site.git");
    expect(JSON.stringify(got.body)).not.toContain(token);

    const clone = await call(panel, serviceOps.clone, { serviceId, projectId, nodeId }, { cookie });
    expect(clone.status).toBe(200);
    const copied = panel.deps.db.select().from(serviceBoxes).where(eq(serviceBoxes.serviceId, clone.body.service.id)).get();
    expect(copied?.repository).toBe("https://github.com/acme/site.git");
  });
});
