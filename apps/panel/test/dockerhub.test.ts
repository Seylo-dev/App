// dockerHub.* through the real op pipeline: who may call them, the saved
// Docker Hub login from the registries module, and dockerHub.create making
// an app with its port, volumes, env, domain and deploy. Docker Hub is the
// fake in dockerhub-fake.ts (recorded answers, no network).
//
// DOCKERHUB_LIVE=1 also runs one search, tag list and inspect against the
// real Docker Hub (needs the network; spends at most one anonymous pull).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dockerHub, projects } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { auditLog, deployments, domains, grants, nodes, portExposures, registryCredentials, services, volumes } from "../src/db/schema";
import { DockerHubClient } from "../src/modules/dockerHub/client";
import { readServiceEnv } from "../src/modules/env/store";
import { FakeDockerHub, meta } from "./dockerhub-fake";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { noLimits } from "./people-helpers";

const realFetch = globalThis.fetch;
let panel: TestPanel;
let fleet: FakeFleet;
let hub: FakeDockerHub;
let owner: string;
let projectId: string;
let nodeA: string;

beforeEach(async () => {
  hub = new FakeDockerHub({ login: { username: "acme", password: "dckr_pat_test" } });
  globalThis.fetch = hub.fetch as typeof fetch;
  panel = testPanel({ rateLimiter: noLimits });
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  ({ cookie: owner } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "apps" }, { cookie: owner })).body.id;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  panel.close();
});

function saveDockerHubLogin(server = "docker.io", password = "dckr_pat_test") {
  return panel.deps.db
    .insert(registryCredentials)
    .values({ name: "Docker Hub", server, username: "acme", passwordSealed: panel.deps.secrets.seal(password, "registry.credential") })
    .returning()
    .get().id;
}

describe("reading Docker Hub", () => {
  test("any signed-in person may search, list tags and inspect; anonymous callers may not", async () => {
    const { cookie: member } = await createUser(panel, "member");
    expect((await callOp(panel, dockerHub.search, { query: "gitea" })).status).toBe(401);
    const search = await callOp(panel, dockerHub.search, { query: "gitea" }, { cookie: member });
    expect(search.status).toBe(200);
    expect(search.body.results[0].badge).toBe("verified");
    const tags = await callOp(panel, dockerHub.tags, { repository: "gitea/gitea" }, { cookie: member });
    expect(tags.body.suggested).toBe("28.3.0");
    const config = await callOp(panel, dockerHub.inspect, { repository: "gitea/gitea", tag: meta.tag, arch: "arm64" }, { cookie: member });
    expect(config.status).toBe(200);
    expect(config.body).toMatchObject({ platform: "linux/arm64", volumes: ["/data"], private: false });
    // Reads are not audited.
    expect(panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "dockerHub.search")).all()).toHaveLength(0);
  });

  test("repositories that name another registry are refused before anything is fetched", async () => {
    for (const repository of ["ghcr.io/acme/app", "localhost:5000/app", "a/b/c", "UPPER/case"]) {
      const res = await callOp(panel, dockerHub.inspect, { repository, tag: "1" }, { cookie: owner });
      expect(res.status).toBe(400);
    }
    expect(hub.seen).toHaveLength(0);
  });

  test("the saved Docker Hub login: public pulls use it, private repositories only for registries.manage", async () => {
    saveDockerHubLogin();
    const { cookie: member } = await createUser(panel, "member");
    await callOp(panel, dockerHub.inspect, { repository: "gitea/gitea", tag: meta.tag }, { cookie: member });
    expect(hub.seen.some((s) => s.headers.get("authorization") === "Bearer login-token:gitea/gitea")).toBe(true);
    expect((await callOp(panel, dockerHub.inspect, { repository: "acme/private", tag: "1" }, { cookie: member })).status).toBe(404);
    expect((await callOp(panel, dockerHub.tags, { repository: "acme/private" }, { cookie: member })).status).toBe(404);
    const own = await callOp(panel, dockerHub.inspect, { repository: "acme/private", tag: "1" }, { cookie: owner });
    expect(own.status).toBe(200);
    expect(own.body.private).toBe(true);
    expect((await callOp(panel, dockerHub.tags, { repository: "acme/private" }, { cookie: owner })).body.tags).toHaveLength(1);
  });

  test("a rate limit is a clear 429 with the wait", async () => {
    hub.options.limited = new Set(["hub.docker.com"]);
    const res = await callOp(panel, dockerHub.search, { query: "gitea" }, { cookie: owner });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatchObject({ code: "RATE_LIMITED", details: { reason: "dockerHubRateLimit" } });
  });
});

describe("dockerHub.create", () => {
  const base = () => ({ projectId, name: "git", nodeId: nodeA, repository: "gitea/gitea", tag: meta.tag });

  test("creates the app with its port, volumes, env and automatic domain, then deploys it", async () => {
    panel.deps.db.update(nodes).set({ wildcardDomain: "n1.example.com" }).where(eq(nodes.id, nodeA)).run();
    const res = await callOp(
      panel,
      dockerHub.create,
      {
        ...base(),
        port: 3000,
        volumes: [{ mountPath: "/data" }, { mountPath: "/var/lib/gitea/data/" }],
        env: "USER=git\nGITEA_CUSTOM=/data/gitea\nSECRET_KEY=s3cr3t-value",
      },
      { cookie: owner },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "git",
      kind: "app",
      sourceConfig: { type: "image", image: `gitea/gitea:${meta.tag}`, registryId: null },
      ports: [{ containerPort: 3000, protocol: "tcp" }],
    });
    const id = res.body.id as string;
    expect(
      panel.deps.db
        .select()
        .from(volumes)
        .where(eq(volumes.serviceId, id))
        .all()
        .map((v) => [v.name, v.mountPath]),
    ).toEqual([
      ["data", "/data"],
      ["gitea-data", "/var/lib/gitea/data"],
    ]);
    expect(readServiceEnv(panel.deps.db, panel.deps.secrets, id).text).toBe(
      "USER=git\nGITEA_CUSTOM=/data/gitea\nSECRET_KEY=s3cr3t-value\n",
    );
    expect(
      panel.deps.db
        .select()
        .from(domains)
        .where(eq(domains.serviceId, id))
        .all()
        .map((d) => d.host),
    ).toEqual(["git.n1.example.com"]);
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, id)).all()).toHaveLength(1);
    // The audit entry keeps the call but never the env.
    const entry = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "dockerHub.create")).get();
    expect(JSON.stringify(entry?.input)).not.toContain("s3cr3t-value");
    expect(JSON.stringify(entry?.input)).toContain("gitea/gitea");
    await fleet.settle();
  });

  test("without a wildcard domain the port opens on IP:port; internal ports and deployNow false stay quiet", async () => {
    const open = await callOp(panel, dockerHub.create, { ...base(), port: 3000, deployNow: false }, { cookie: owner });
    expect(open.status).toBe(200);
    expect(panel.deps.db.select().from(portExposures).where(eq(portExposures.serviceId, open.body.id)).all()).toHaveLength(1);
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, open.body.id)).all()).toHaveLength(0);

    const internal = await callOp(
      panel,
      dockerHub.create,
      { ...base(), name: "git2", port: 3000, public: false, deployNow: false },
      { cookie: owner },
    );
    expect(internal.status).toBe(200);
    expect(panel.deps.db.select().from(portExposures).where(eq(portExposures.serviceId, internal.body.id)).all()).toHaveLength(0);
    expect(panel.deps.db.select().from(domains).where(eq(domains.serviceId, internal.body.id)).all()).toHaveLength(0);
  });

  test("official images keep their short name", async () => {
    const res = await callOp(
      panel,
      dockerHub.create,
      { ...base(), repository: "library/nginx", tag: "1.29", deployNow: false },
      { cookie: owner },
    );
    expect(res.body.sourceConfig.image).toBe("nginx:1.29");
  });

  test("needs services.create on the project", async () => {
    const { user, cookie } = await createUser(panel, "member");
    expect((await callOp(panel, dockerHub.create, base(), { cookie })).status).toBe(403);
    grant(panel, user.id, "project", projectId, ["services.view"]);
    expect((await callOp(panel, dockerHub.create, base(), { cookie })).status).toBe(403);
    panel.deps.db
      .update(grants)
      .set({ actions: ["services.view", "services.create"] })
      .where(eq(grants.userId, user.id))
      .run();
    const res = await callOp(panel, dockerHub.create, { ...base(), deployNow: false }, { cookie });
    expect(res.status).toBe(200);
  });

  test("bad input is refused and leaves nothing behind", async () => {
    const cases: [Record<string, unknown>, number][] = [
      [{ env: "NOT A LINE" }, 400],
      [{ env: "A=${{other.SECRET}}" }, 200],
      [{ volumes: [{ mountPath: "/data" }, { mountPath: "/data/" }] }, 400],
      [{ volumes: [{ mountPath: "/" }] }, 400],
      [
        {
          volumes: [
            { mountPath: "/a", name: "x" },
            { mountPath: "/b", name: "x" },
          ],
        },
        400,
      ],
    ];
    for (const [extra, status] of cases) {
      const name = `svc${Math.random().toString(36).slice(2, 8)}`;
      const res = await callOp(panel, dockerHub.create, { ...base(), name, deployNow: false, ...extra }, { cookie: owner });
      expect(res.status).toBe(status);
      if (status !== 200) expect(panel.deps.db.select().from(services).where(eq(services.name, name)).get()).toBeUndefined();
    }
    // The name is taken now.
    await callOp(panel, dockerHub.create, { ...base(), deployNow: false }, { cookie: owner });
    expect((await callOp(panel, dockerHub.create, { ...base(), deployNow: false }, { cookie: owner })).status).toBe(409);
  });

  test("env references follow env.set's rule", async () => {
    const { user, cookie } = await createUser(panel, "member");
    const secretService = await callOp(panel, dockerHub.create, { ...base(), name: "vault", deployNow: false }, { cookie: owner });
    grant(panel, user.id, "service", secretService.body.id, ["services.view"]);
    const other = (await callOp(panel, projects.create, { name: "mine" }, { cookie: owner })).body.id;
    grant(panel, user.id, "project", other, ["*"]);
    // The member's own project: references to a service there that they can read are fine.
    const ok = await callOp(
      panel,
      dockerHub.create,
      { ...base(), projectId: other, name: "a", deployNow: false, env: "X=${{a.Y}}" },
      { cookie },
    );
    expect(ok.status).toBe(200);
    grant(panel, user.id, "project", projectId, ["services.create"]);
    const refused = await callOp(
      panel,
      dockerHub.create,
      { ...base(), name: "b", deployNow: false, env: "X=${{vault.TOKEN}}" },
      { cookie },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.details.reference).toBe("vault.TOKEN");
  });

  test("a registry login must be Docker Hub's, and only admins attach it to a new project", async () => {
    const ghcr = panel.deps.db
      .insert(registryCredentials)
      .values({ name: "GHCR", server: "ghcr.io", username: "acme", passwordSealed: panel.deps.secrets.seal("x", "registry.credential") })
      .returning()
      .get().id;
    expect((await callOp(panel, dockerHub.create, { ...base(), registryId: ghcr, deployNow: false }, { cookie: owner })).status).toBe(400);
    const docker = saveDockerHubLogin("index.docker.io");
    const res = await callOp(panel, dockerHub.create, { ...base(), registryId: docker, deployNow: false }, { cookie: owner });
    expect(res.status).toBe(200);
    expect(res.body.sourceConfig.registryId).toBe(docker);
    const { user, cookie } = await createUser(panel, "member");
    const fresh = (await callOp(panel, projects.create, { name: "fresh" }, { cookie: owner })).body.id;
    grant(panel, user.id, "project", fresh, ["*"]);
    const member = await callOp(panel, dockerHub.create, { ...base(), projectId: fresh, registryId: docker, deployNow: false }, { cookie });
    expect(member.status).toBe(403);
  });
});

describe.if(process.env.DOCKERHUB_LIVE === "1")("live Docker Hub", () => {
  test("search, tags and inspect against hub.docker.com and registry-1.docker.io", async () => {
    globalThis.fetch = realFetch;
    const client = new DockerHubClient();
    const search = await client.search("nginx", 1);
    expect(search.results[0]?.repository).toBe("nginx");
    expect(search.results[0]?.badge).toBe("official");
    const tags = await client.tags("nginx", { page: 1, access: { login: null, privateAccess: false } });
    expect(tags.suggested).toMatch(/^\d+\.\d+\.\d+$/);
    const config = await client.inspect("nginx", tags.suggested as string, "amd64", { login: null, privateAccess: false });
    expect(config.ports).toContainEqual({ port: 80, protocol: "tcp" });
    expect(config.platforms).toContain("linux/arm64/v8");
  }, 60_000);
});
