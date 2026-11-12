// NODE_ENV=production for apps (env/desired.ts withNodeEnv, 0.2.14): every
// app's deploy starts with it unless its own .env or the project's shared
// variables set NODE_ENV (any value, also empty), like PORT for built apps.
// Image apps, compose members and PR previews get it too; databases, Boxes,
// cron services and the panel's own service do not. Builds never get it,
// so a Dockerfile's `npm ci` keeps installing devDependencies.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compose, deployments as deploymentOps, projects, services as serviceOps } from "@seylo/ops";
import { DeployStage } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { deployments, services } from "../src/db/schema";
import { compileMemo } from "../src/desired/contributors";
import { networkingContributor } from "../src/modules/domains/contributor";
import { deploymentEnv, sealDeploymentEnv, withNodeEnv, withPortEnv } from "../src/modules/env/desired";
import { writeProjectEnv, writeServiceEnv } from "../src/modules/env/store";
import { ensurePanelService, panelServiceId } from "../src/modules/nodes/panel-service";
import { serviceSpecFor } from "../src/modules/services/desired";
import { readSpec } from "../src/modules/services/spec";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { seedService } from "./seed-helpers";

const production = { name: "NODE_ENV", value: "production", secret: false };

describe("withNodeEnv", () => {
  const app = { id: "svc0000000000001", kind: "app" };

  test("adds NODE_ENV=production to an app's env", () => {
    expect(withNodeEnv([{ name: "A", value: "1", secret: false }], app)).toEqual([{ name: "A", value: "1", secret: false }, production]);
    expect(withNodeEnv([], app)).toEqual([production]);
  });

  test("keeps a NODE_ENV the env sets, whatever its value, also empty", () => {
    for (const value of ["production", "development", "staging", ""]) {
      const own = [{ name: "NODE_ENV", value, secret: false }];
      expect(withNodeEnv(own, app)).toEqual(own);
    }
  });

  test("leaves databases, Boxes, cron services and the panel alone", () => {
    for (const kind of ["postgres", "mysql", "redis", "box", "cron", "compose"]) expect(withNodeEnv([], { id: app.id, kind })).toEqual([]);
    expect(withNodeEnv([], { id: panelServiceId, kind: "app" })).toEqual([]);
  });

  test("goes next to PORT, which it does not touch", () => {
    const git = { type: "git" as const, url: "https://github.com/acme/shop.git", branch: "main", credentialId: null, deployOnPush: false };
    const withPort = withPortEnv([], { kind: "app", parentId: null }, { source: git, ports: [] });
    expect(withNodeEnv(withPort, app)).toEqual([{ name: "PORT", value: "80", secret: false }, production]);
  });
});

describe("NODE_ENV in what apps deploy with", () => {
  let panel: TestPanel;
  let fleet: FakeFleet;
  let cookie: string;
  let projectId: string;
  let nodeA: string;

  beforeEach(async () => {
    panel = testPanel();
    fleet = new FakeFleet(panel);
    nodeA = fleet.addNode("node-a");
    fleet.addNode("builder", { canBuild: true, panelNode: true });
    ({ cookie } = await createUser(panel, "owner"));
    projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
  });
  afterEach(() => panel.close());

  async function createApp(name: string, source: unknown) {
    const res = await callOp(
      panel,
      serviceOps.create,
      { projectId, name, kind: "app", nodeId: nodeA, source, ports: [{ containerPort: 3000, protocol: "tcp" }] } as never,
      { cookie },
    );
    expect(res.status).toBe(200);
    return res.body.id as string;
  }

  /** An app built from an inline Dockerfile, so its deploy runs a build. */
  async function builtApp(name: string) {
    const id = await createApp(name, { type: "inline" });
    const row = panel.deps.db.select().from(services).where(eq(services.id, id)).get();
    panel.deps.db
      .update(services)
      .set({ spec: { ...(row?.spec as object), build: { builder: "dockerfile", inlineDockerfile: "FROM node:24\nRUN npm ci\n" } } })
      .where(eq(services.id, id))
      .run();
    return id;
  }

  async function deploy(serviceId: string) {
    const res = await callOp(panel, deploymentOps.deploy, { serviceId }, { cookie });
    expect(res.status).toBe(200);
    await fleet.settle();
    return res.body.id as string;
  }

  /** The env the build request of the i-th build carried. */
  const buildEnv = (i: number) => (fleet.builds[i]?.request.env ?? []) as { name: string; value: string }[];
  const sealedEnv = (deploymentId: string) =>
    deploymentEnv(panel.deps, panel.deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get()?.envSealed ?? null);
  const nodeEnvOf = (env: { name?: string; value?: string; secret?: boolean }[] | null | undefined) =>
    env?.filter((v) => v.name === "NODE_ENV");
  const sealedNodeEnv = (serviceId: string) => nodeEnvOf(deploymentEnv(panel.deps, sealDeploymentEnv(panel.deps, serviceId)));

  /** The env the node gets for the service, through the networking contributor (as the desired-state compile runs it). */
  function compiledEnv(serviceId: string) {
    const svc = panel.deps.db.select().from(services).where(eq(services.id, serviceId)).get();
    const spec = serviceSpecFor(panel.deps.db, panel.deps.secrets, serviceId, nodeA);
    if (!svc || !spec) throw new Error("no spec");
    networkingContributor.service?.({
      db: panel.deps.db,
      secrets: panel.deps.secrets,
      nodeId: nodeA,
      service: svc,
      spec,
      memo: compileMemo(),
    });
    return spec.env.map((v) => ({ name: v.name, value: v.value }));
  }

  test("a built app runs with NODE_ENV=production, but builds without it", async () => {
    // Before 0.2.14: no NODE_ENV in the container unless the .env had one.
    const id = await builtApp("api");
    writeServiceEnv(panel.deps.db, panel.deps.secrets, id, "GREETING=hi\n", null);
    const depId = await deploy(id);

    expect(fleet.builds).toHaveLength(1);
    expect(buildEnv(0).map((v) => v.name)).toEqual(["GREETING"]);
    expect(nodeEnvOf(sealedEnv(depId))).toEqual([production]);

    const generation = panel.deps.db.select().from(deployments).where(eq(deployments.id, depId)).get()?.generation ?? 0;
    fleet.deployProgress(nodeA, id, generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    expect(compiledEnv(id)).toContainEqual({ name: "NODE_ENV", value: "production" });
    expect(compiledEnv(id)).toContainEqual({ name: "GREETING", value: "hi" });
  });

  test("a NODE_ENV in the app's .env wins, also development and empty, and still reaches its build", async () => {
    const id = await builtApp("api");
    writeServiceEnv(panel.deps.db, panel.deps.secrets, id, "NODE_ENV=development\n", null);
    const dev = await deploy(id);
    expect(buildEnv(0).map((v) => [v.name, v.value])).toEqual([["NODE_ENV", "development"]]);
    expect(nodeEnvOf(sealedEnv(dev))).toEqual([{ name: "NODE_ENV", value: "development", secret: false }]);

    writeServiceEnv(panel.deps.db, panel.deps.secrets, id, "NODE_ENV=\n", null);
    expect(sealedNodeEnv(id)).toEqual([{ name: "NODE_ENV", value: "", secret: false }]);
    writeServiceEnv(panel.deps.db, panel.deps.secrets, id, "NODE_ENV=production\n", null);
    expect(sealedNodeEnv(id)).toEqual([production]);
  });

  test("a NODE_ENV in the project's shared variables wins too", async () => {
    const id = await createApp("web", { type: "image", image: "nginx:1.27", registryId: null });
    writeProjectEnv(panel.deps.db, panel.deps.secrets, projectId, "NODE_ENV=staging\n", null);
    expect(sealedNodeEnv(id)).toEqual([{ name: "NODE_ENV", value: "staging", secret: false }]);
    // The app's own value beats the shared one, as for any variable.
    writeServiceEnv(panel.deps.db, panel.deps.secrets, id, "NODE_ENV=test\n", null);
    expect(sealedNodeEnv(id)).toEqual([{ name: "NODE_ENV", value: "test", secret: false }]);
  });

  test("image apps and PR previews get it, without PORT", async () => {
    const image = await createApp("web", { type: "image", image: "nginx:1.27", registryId: null });
    const env = deploymentEnv(panel.deps, sealDeploymentEnv(panel.deps, image));
    expect(env).toContainEqual(production);
    expect(env?.some((v) => v.name === "PORT")).toBe(false);

    const preview = await createApp("web-pr-7", { type: "image", image: "nginx:1.27", registryId: null });
    const row = panel.deps.db.select().from(services).where(eq(services.id, preview)).get();
    panel.deps.db
      .update(services)
      .set({ spec: { ...readSpec(row?.spec), preview: { ofServiceId: image, prNumber: 7 } } })
      .where(eq(services.id, preview))
      .run();
    expect(sealedNodeEnv(preview)).toEqual([production]);
  });

  test("compose members get it unless their environment: block sets NODE_ENV", async () => {
    fleet.answers.set("parseCompose", () => ({
      projectJson: new TextEncoder().encode(
        JSON.stringify({
          name: "stack",
          services: {
            web: { image: "node:24", environment: { GREETING: "hello" } },
            worker: { image: "node:24", environment: { NODE_ENV: "development" } },
          },
        }),
      ),
      warnings: [],
    }));
    const yaml = "services:\n  web:\n    image: node:24\n  worker:\n    image: node:24\n";
    const res = await callOp(
      panel,
      compose.create,
      { projectId, name: "stack", nodeId: nodeA, source: { type: "inline", yaml } },
      { cookie },
    );
    expect(res.status).toBe(200);
    await fleet.settle();
    const members = res.body.members as { id: string; name: string }[];
    const sealedOf = (name: string) => {
      const id = members.find((m) => m.name === name)?.id ?? "";
      const row = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, id)).get();
      return nodeEnvOf(deploymentEnv(panel.deps, row?.envSealed ?? null));
    };
    expect(sealedOf("stack-web")).toEqual([production]);
    expect(sealedOf("stack-worker")).toEqual([{ name: "NODE_ENV", value: "development", secret: false }]);
  });

  test("databases, Boxes, cron services and the panel's own service get none", () => {
    for (const kind of ["postgres", "box", "cron"] as const) {
      const row = seedService(panel, { projectId, name: `x-${kind}`, kind, nodeIds: [nodeA] });
      expect(sealedNodeEnv(row.id)).toEqual([]);
    }
    panel.deps.config.image = `ghcr.io/seylo-dev/seylo:0.2.14@sha256:${"a".repeat(64)}`;
    expect(ensurePanelService(panel.deps)).toBe("created");
    expect(sealedNodeEnv(panelServiceId)).toEqual([]);
  });
});
