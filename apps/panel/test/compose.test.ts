import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compose, exposures, OpError, projects, services as serviceOps } from "@seylo/ops";
import { ServiceKind } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { deployments, services, volumes } from "../src/db/schema";
import { durationSeconds, memberName, planStack } from "../src/modules/compose/plan";
import { readServiceEnv } from "../src/modules/env/store";
import { serviceSpecFor } from "../src/modules/services/desired";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let nodeA: string;

// What compose-go's normalized project looks like for the files below.
const projectFor = (yaml: string) => {
  const withDb = yaml.includes("db:");
  return {
    name: "stack",
    services: {
      web: {
        image: yaml.includes("nginx:1.28") ? "nginx:1.28" : "nginx:1.27",
        ports: [{ target: 80, published: "8080", protocol: "tcp" }],
        volumes: [{ type: "volume", source: "shared", target: "/srv" }],
        environment: { DB_HOST: "db", GREETING: "hello world" },
        ...(withDb ? { depends_on: { db: { condition: "service_started" } } } : {}),
        healthcheck: { test: ["CMD-SHELL", "curl -f localhost"], interval: "15s", timeout: "5s", retries: 3 },
      },
      ...(withDb
        ? {
            db: {
              image: "postgres:17",
              volumes: [
                { type: "volume", source: "shared", target: "/backup" },
                { type: "volume", source: "pgdata", target: "/var/lib/postgresql/data" },
              ],
              environment: { POSTGRES_PASSWORD: "secret" },
              restart: "no",
            },
          }
        : {}),
    },
  };
};

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  fleet.answers.set("parseCompose", (_nodeId, req: { composeYaml: string }) => ({
    projectJson: new TextEncoder().encode(JSON.stringify(projectFor(req.composeYaml))),
    warnings: ["host networking is ignored"],
  }));
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
});
afterEach(() => panel.close());

const file = "services:\n  web:\n    image: nginx:1.27\n  db:\n    image: postgres:17\n";

describe("compose plan", () => {
  test("durations and names", () => {
    expect(durationSeconds("1m30s", 0)).toBe(90);
    expect(durationSeconds(15_000_000_000, 0)).toBe(15);
    expect(durationSeconds("", 7)).toBe(7);
    expect(memberName("stack", "My_DB")).toBe("stack-my-db");
  });

  test("build contexts resolve next to the compose file", () => {
    const plan = planStack(
      "app",
      { services: { api: { build: { context: "./api", dockerfile: "Dockerfile.prod" } } } },
      { type: "github", installationId: "a".repeat(16), repo: "acme/shop", branch: "main", path: "deploy/compose.yml", deployOnPush: true },
    );
    expect(plan.members[0]?.build).toEqual({ contextPath: "deploy/api", dockerfilePath: "Dockerfile.prod", target: "" });
  });

  test("build: sections are the panel's call, not an older agent's warning", () => {
    const legacy = "api: build sections are not built for compose stacks; give the service an image";
    const project = { services: { api: { build: { context: "." } } } };
    const repo = planStack(
      "app",
      project,
      { type: "github", installationId: "a".repeat(16), repo: "acme/shop", branch: "main", path: "compose.yml", deployOnPush: true },
      [legacy, "api: port 80 is published on the host as 8080"],
    );
    expect(repo.members[0]?.build).not.toBeNull();
    expect(repo.warnings).toEqual(["api: port 80 is published on the host as 8080"]);
    const pasted = planStack("app", project, { type: "inline", yaml: "" }, [legacy]);
    expect(pasted.warnings).toContain("api: build: needs a repository; pasted files must use image:.");
    expect(pasted.warnings).not.toContain(legacy);
  });
});

describe("compose stacks", () => {
  test("preview shows members, shared volumes and warnings without creating anything", async () => {
    const res = await callOp(
      panel,
      compose.preview,
      { projectId, name: "stack", nodeId: nodeA, source: { type: "inline", yaml: file } },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: { name: string; action: string }) => [m.name, m.action])).toEqual([
      ["stack-db", "create"],
      ["stack-web", "create"],
    ]);
    const web = res.body.members.find((m: { name: string }) => m.name === "stack-web");
    expect(web).toMatchObject({
      image: "nginx:1.27",
      ports: [80],
      dependsOn: ["db"],
      envKeys: ["DB_HOST", "GREETING"],
      hasHealthCheck: true,
    });
    expect(web.volumes).toEqual([{ name: "shared", mountPath: "/srv", sharedWith: ["stack-db"] }]);
    expect(res.body.warnings).toContain("host networking is ignored");
    expect(panel.deps.db.select().from(services).all()).toHaveLength(0);
  });

  test("compose files from any git host are read by an agent", async () => {
    fleet.answers.set("fetchGitFile", () => ({
      content: new TextEncoder().encode(file),
      commit: "c".repeat(40),
      sizeBytes: BigInt(file.length),
    }));
    const source = {
      type: "git",
      url: "https://git.example.com/acme/shop.git",
      branch: "main",
      path: "deploy/compose.yml",
      credentialId: null,
      deployOnPush: false,
    } as const;
    const res = await callOp(panel, compose.preview, { projectId, name: "stack", nodeId: nodeA, source }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: { name: string }) => m.name)).toEqual(["stack-db", "stack-web"]);
    const call = fleet.calls.find((c) => c.method === "fetchGitFile");
    expect(call?.nodeId).toBe(nodeA);
    expect(call?.request).toMatchObject({
      source: { url: "https://git.example.com/acme/shop.git", ref: "main", commit: "", token: "" },
      path: "deploy/compose.yml",
      maxBytes: 1048576n,
    });

    // The agent's own error (file missing, bad credentials) comes back as a bad request about the path.
    fleet.answers.set("fetchGitFile", () => {
      throw new OpError("NOT_FOUND", "deploy/compose.yml does not exist at main", { reason: "agent" });
    });
    const missing = await callOp(panel, compose.preview, { projectId, name: "stack", nodeId: nodeA, source }, { cookie });
    expect(missing.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "source.path" } });
    expect(missing.body.error.message).toContain("does not exist at main");
  });

  test("create splits the stack into members that deploy, share volumes and wait for each other", async () => {
    const res = await callOp(
      panel,
      compose.create,
      { projectId, name: "stack", nodeId: nodeA, source: { type: "inline", yaml: file } },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(res.body.stack.kind).toBe("compose");
    expect(res.body.members.map((m: { name: string }) => m.name)).toEqual(["stack-db", "stack-web"]);
    await fleet.settle();
    const [db, web] = res.body.members as { id: string }[];
    expect(panel.deps.db.select().from(deployments).all()).toHaveLength(2);

    // The pasted file is sealed, not in the spec JSON.
    const stackRow = panel.deps.db.select().from(services).where(eq(services.id, res.body.stack.id)).get();
    expect(JSON.stringify(stackRow?.spec)).not.toContain("postgres");
    const got = await callOp(panel, compose.get, { serviceId: res.body.stack.id }, { cookie });
    expect(got.body.source.yaml).toBe(file);

    expect(readServiceEnv(panel.deps.db, panel.deps.secrets, (db as { id: string }).id).text).toBe("POSTGRES_PASSWORD=secret\n");
    const shared = panel.deps.db.select().from(volumes).where(eq(volumes.name, "shared")).all();
    expect(shared.find((v) => v.serviceId === (db as { id: string }).id)?.ownerServiceId).toBeNull();
    expect(shared.find((v) => v.serviceId === (web as { id: string }).id)?.ownerServiceId).toBe((db as { id: string }).id);

    const spec = serviceSpecFor(panel.deps.db, panel.deps.secrets, (web as { id: string }).id, nodeA);
    expect(spec?.kind).toBe(ServiceKind.COMPOSE_MEMBER);
    expect(spec?.networkAliases).toEqual(["web"]);
    expect(spec?.kindSpec).toMatchObject({
      case: "composeMember",
      value: { stackId: res.body.stack.id, composeService: "web", dependsOn: [(db as { id: string }).id] },
    });
    expect(spec?.volumes.find((v) => v.name === "shared")?.ownerServiceId).toBe((db as { id: string }).id);
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, res.body.stack.id, nodeA)).toBeNull();
    const dbSpec = serviceSpecFor(panel.deps.db, panel.deps.secrets, (db as { id: string }).id, nodeA);
    expect(dbSpec?.crashPolicy?.restart).toBe(false);

    // web publishes 8080:80 in the file, so it is reachable on IP:port until it has a domain; db publishes nothing.
    const webAccess = await callOp(panel, exposures.get, { serviceId: (web as { id: string }).id }, { cookie });
    expect(webAccess.body.firstRun).toMatchObject({ status: "open" });
    const dbAccess = await callOp(panel, exposures.get, { serviceId: (db as { id: string }).id }, { cookie });
    expect(dbAccess.body.firstRun.status).not.toBe("open");

    const detail = await callOp(panel, serviceOps.get, { serviceId: res.body.stack.id }, { cookie });
    expect(detail.body.members.map((m: { name: string }) => m.name)).toEqual(["stack-db", "stack-web"]);
  });

  test("update diffs the file, deletes removed members and redeploys changed ones", async () => {
    const created = await callOp(
      panel,
      compose.create,
      { projectId, name: "stack", nodeId: nodeA, source: { type: "inline", yaml: file } },
      { cookie },
    );
    await fleet.settle();
    const next = "services:\n  web:\n    image: nginx:1.28\n";
    const dry = await callOp(
      panel,
      compose.update,
      { serviceId: created.body.stack.id, source: { type: "inline", yaml: next }, dryRun: true },
      { cookie },
    );
    expect(dry.body.members.map((m: { name: string; action: string }) => [m.name, m.action])).toEqual([
      ["stack-web", "update"],
      ["stack-db", "delete"],
    ]);
    expect(panel.deps.db.select().from(services).all()).toHaveLength(3);

    const same = await callOp(
      panel,
      compose.update,
      { serviceId: created.body.stack.id, source: { type: "inline", yaml: file }, dryRun: true },
      { cookie },
    );
    expect(same.body.members.every((m: { action: string }) => m.action === "unchanged")).toBe(true);

    const applied = await callOp(
      panel,
      compose.update,
      { serviceId: created.body.stack.id, source: { type: "inline", yaml: next } },
      { cookie },
    );
    expect(applied.status).toBe(200);
    await fleet.settle();
    const names = panel.deps.db
      .select({ name: services.name })
      .from(services)
      .all()
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(["stack", "stack-web"]);
    const web = panel.deps.db.select().from(services).where(eq(services.name, "stack-web")).get();
    expect(
      panel.deps.db
        .select()
        .from(deployments)
        .where(eq(deployments.serviceId, web?.id as string))
        .all(),
    ).toHaveLength(2);
  });

  test("deleting the stack deletes its members; members cannot be deleted alone", async () => {
    const created = await callOp(
      panel,
      compose.create,
      { projectId, name: "stack", nodeId: nodeA, source: { type: "inline", yaml: file } },
      { cookie },
    );
    await fleet.settle();
    const member = created.body.members[0];
    const alone = await callOp(panel, serviceOps.remove, { serviceId: member.id, confirmName: member.name }, { cookie });
    expect(alone.body.error.code).toBe("CONFLICT");
    const res = await callOp(panel, serviceOps.remove, { serviceId: created.body.stack.id, confirmName: "stack" }, { cookie });
    expect(res.status).toBe(200);
    expect(panel.deps.db.select().from(services).all()).toHaveLength(0);
  });
});
