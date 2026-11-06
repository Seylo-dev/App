// Members cannot aim the owner's git tokens, registry logins or GitHub App at
// hosts or projects of their choosing, and image sources cannot pull other
// services' builds from the panel registry relay.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { git as gitOps, registries as registryOps, services as serviceOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { gitCredentials, registryCredentials, services } from "../src/db/schema";
import { assertImageAllowed, imageRegistry, registryMatches } from "../src/modules/services/source-guard";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
let owner: string;
beforeEach(async () => {
  panel = testPanel();
  owner = (await createUser(panel, "owner")).cookie;
});
afterEach(() => panel.close());

function credential(host: string) {
  return panel.deps.db
    .insert(gitCredentials)
    .values({
      name: `pat ${host}`,
      kind: "token",
      host,
      username: "owner",
      secretSealed: panel.deps.secrets.seal("ghp_SECRET", "git.credential"),
    })
    .returning()
    .get();
}

function registry(server: string) {
  return panel.deps.db
    .insert(registryCredentials)
    .values({ name: server, server, username: "owner", passwordSealed: panel.deps.secrets.seal("pw", "registry.credential") })
    .returning()
    .get();
}

async function memberOn() {
  const node = seedNode(panel);
  const project = seedProject(panel);
  const service = seedService(panel, { projectId: project.id, name: "api", nodeIds: [node.id] });
  const member = await createUser(panel, "member");
  grant(panel, member.user.id, "service", service.id, ["services.update", "services.view"]);
  return { project, service, node, member };
}

describe("git credentials", () => {
  test("a credential never goes to another host, and a member needs it shared in the project first", async () => {
    const { project, service, node, member } = await memberOn();
    const pat = credential("github.com");
    const as = { cookie: member.cookie };
    const elsewhere = await callOp(
      panel,
      serviceOps.setSource,
      {
        serviceId: service.id,
        source: { type: "git", url: "https://git.attacker.example/x.git", branch: "main", credentialId: pat.id, deployOnPush: false },
      },
      as,
    );
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.body.error.details.field).toBe("source.credentialId");

    const github = {
      type: "git" as const,
      url: "https://github.com/owner/private.git",
      branch: "main",
      credentialId: pat.id,
      deployOnPush: false,
    };
    const notShared = await callOp(panel, serviceOps.setSource, { serviceId: service.id, source: github }, as);
    expect(notShared.status).toBe(403);

    // An admin uses it in this project; then the member may use it here too.
    const sibling = seedService(panel, { projectId: project.id, name: "web", nodeIds: [node.id] });
    expect((await callOp(panel, serviceOps.setSource, { serviceId: sibling.id, source: github }, { cookie: owner })).status).toBe(200);
    expect((await callOp(panel, serviceOps.setSource, { serviceId: service.id, source: github }, as)).status).toBe(200);

    // Even the owner cannot send it to a different host.
    const ownerElsewhere = await callOp(
      panel,
      serviceOps.setSource,
      { serviceId: sibling.id, source: { ...github, url: "https://gitlab.example.com/x.git" } },
      { cookie: owner },
    );
    expect(ownerElsewhere.status).toBe(400);
  });

  test("members see credential names and hosts, not the account details", async () => {
    const { member } = await memberOn();
    credential("github.com");
    const listed = await callOp(panel, gitOps.listCredentials, {}, { cookie: member.cookie });
    expect(listed.status).toBe(200);
    expect(listed.body.items[0]).toMatchObject({ host: "github.com", username: null });
    const full = await callOp(panel, gitOps.listCredentials, {}, { cookie: owner });
    expect(full.body.items[0].username).toBe("owner");
  });
});

describe("images and registries", () => {
  test("image sources cannot come from the node or the registry relay", async () => {
    const { service, member } = await memberOn();
    const victim = seedService(panel, { projectId: seedProject(panel).id, name: "victim" });
    for (const image of [
      `127.0.0.1:5755/${victim.id}:7`,
      `localhost:5755/${victim.id}:1`,
      `localtest.me:5755/${victim.id}:1`,
      "[::1]:5755/x:1",
    ]) {
      const res = await callOp(
        panel,
        serviceOps.setSource,
        { serviceId: service.id, source: { type: "image", image, registryId: null } },
        { cookie: member.cookie },
      );
      expect([image, res.status, res.body.error?.details?.reason]).toEqual([image, 400, "internalRegistry"]);
    }
    const ok = await callOp(
      panel,
      serviceOps.setSource,
      { serviceId: service.id, source: { type: "image", image: "ghcr.io/acme/api:1.4", registryId: null } },
      { cookie: member.cookie },
    );
    expect(ok.status).toBe(200);
  });

  test("a registry login only goes to its own registry", async () => {
    const { service } = await memberOn();
    const ghcr = registry("ghcr.io");
    const wrong = await callOp(
      panel,
      serviceOps.setSource,
      { serviceId: service.id, source: { type: "image", image: "attacker.example/x:1", registryId: ghcr.id } },
      { cookie: owner },
    );
    expect(wrong.status).toBe(400);
    const right = await callOp(
      panel,
      serviceOps.setSource,
      { serviceId: service.id, source: { type: "image", image: "ghcr.io/acme/api:1", registryId: ghcr.id } },
      { cookie: owner },
    );
    expect(right.status).toBe(200);
    const row = panel.deps.db.select().from(services).where(eq(services.id, service.id)).get();
    const spec = row?.spec as { source: { registryId: string } } | undefined;
    expect(spec?.source.registryId).toBe(ghcr.id);
    expect((await callOp(panel, registryOps.list, {}, { cookie: owner })).body.registries[0].username).toBe("owner");
  });

  test("reference parsing", () => {
    expect(imageRegistry("nginx:1.27")).toBe("docker.io");
    expect(imageRegistry("library/nginx")).toBe("docker.io");
    expect(imageRegistry("ghcr.io/a/b:1")).toBe("ghcr.io");
    expect(imageRegistry("localhost:5000/a")).toBe("localhost:5000");
    expect(registryMatches("docker.io", "nginx")).toBe(true);
    expect(registryMatches("index.docker.io", "nginx:1")).toBe(true);
    expect(registryMatches("ghcr.io", "nginx")).toBe(false);
    expect(() => assertImageAllowed("127.0.0.2/x")).toThrow();
    expect(() => assertImageAllowed("registry.example.com:5000/x")).not.toThrow();
  });
});
