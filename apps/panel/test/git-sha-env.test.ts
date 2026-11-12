// GIT_SHA (0.2.14): a deployment built from a repository runs with the full
// commit its image was built from, as on Easypanel, where Respo's api
// refused to start without it ("APP_VERSION: missing: set APP_VERSION or
// GIT_SHA"). The node passes it to the build (go/internal/build); these
// tests cover the containers' env: it follows the deployment, a GIT_SHA of
// the service's own or the project's shared one wins, rollbacks run the
// old commit, and running services are not recreated for it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deployments as deploymentOps, projects, services as serviceOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { deployments, services } from "../src/db/schema";
import { compileMemo } from "../src/desired/contributors";
import { networkingContributor } from "../src/modules/domains/contributor";
import { deploymentEnv, sealDeploymentEnv } from "../src/modules/env/desired";
import { recordBuiltCommit } from "../src/modules/env/git-sha";
import { writeProjectEnv, writeServiceEnv } from "../src/modules/env/store";
import { serviceSpecFor } from "../src/modules/services/desired";
import { setTargetResolver } from "../src/modules/uptime/targets";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

const shaA = "ff9410c96aa507f27425f3c5dbb8e6bf8c4c37f9";
const shaB = "3b8d2aa0c3f1e5d7b9a1c2e4f6a8b0d1e3f5a7c9";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let nodeA: string;

beforeEach(async () => {
  // gitea.lan is internal: the panel never lists its refs itself, so a deploy of the branch
  // knows its commit only once the node fetched it (BuildSourceInfo).
  setTargetResolver(async (host) => {
    if (host === "gitea.lan") return ["10.0.0.7"];
    throw new Error("NXDOMAIN");
  });
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  fleet.addNode("builder", { canBuild: true, panelNode: true });
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "respo" }, { cookie })).body.id;
});
afterEach(() => {
  setTargetResolver(null);
  panel.close();
});

const gitSource = { type: "git", url: "https://gitea.lan/acme/respo.git", branch: "main", credentialId: null, deployOnPush: false };

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

/** Deploys and lets the node report the new version running, so it goes live. */
async function deployLive(serviceId: string, input: { commitSha?: string } = {}) {
  const res = await callOp(panel, deploymentOps.deploy, { serviceId, ...input }, { cookie });
  expect(res.status).toBe(200);
  await fleet.settle();
  return goLive(serviceId, res.body.id as string);
}

async function goLive(serviceId: string, deploymentId: string) {
  const d = panel.deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
  if (!d) throw new Error("no deployment");
  fleet.reportRunning(nodeA, serviceId, d.generation);
  await fleet.settle();
  expect(panel.deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get()?.status).toBe("live");
  return deploymentId;
}

/** The env the desired-state compile sends the node for the service's containers. */
function containerEnv(serviceId: string): Record<string, string> {
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
  return Object.fromEntries(spec.env.map((v) => [v.name, v.value]));
}

/** The node checks out `commit` and says so, as every agent does for git sources. */
function nodeChecksOut(commit: string) {
  fleet.buildScript = () => ({
    result: "succeeded",
    digest: `sha256:${commit.slice(0, 8).padEnd(64, "0")}`,
    sourceInfo: { commit, subject: "deploy", author: "Dana" },
  });
}

describe("GIT_SHA for deployments built from a repository", () => {
  test("a deploy of the branch runs with the commit the node checked out, and a restart keeps it", async () => {
    // Before: no GIT_SHA, so an image that reads it at boot refused to start.
    const id = await createApp("api", gitSource);
    nodeChecksOut(shaA);
    const dep = await deployLive(id);

    expect(containerEnv(id).GIT_SHA).toBe(shaA);
    expect((await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: dep }, { cookie })).body.deployment.commit.sha).toBe(
      shaA,
    );
    // The panel sends no GIT_SHA to the build: the node adds the commit it checks out.
    const buildEnv = (fleet.builds[0]?.request.env ?? []) as { name: string }[];
    expect(buildEnv.some((v) => v.name === "GIT_SHA")).toBe(false);

    expect((await callOp(panel, serviceOps.restart, { serviceId: id }, { cookie })).status).toBe(200);
    expect(containerEnv(id).GIT_SHA).toBe(shaA);
  });

  test("a deploy of a known commit gets it from the panel's own lookup, before the node says anything", async () => {
    // Agents that report nothing still give the containers GIT_SHA.
    const id = await createApp("api", gitSource);
    fleet.buildScript = () => ({ result: "succeeded", digest: `sha256:${"b".repeat(64)}` });
    await deployLive(id, { commitSha: shaB });
    expect(containerEnv(id).GIT_SHA).toBe(shaB);
  });

  test("a short commit id (a deploy URL's) gets the full one the node checked out", async () => {
    const id = await createApp("api", gitSource);
    nodeChecksOut(shaA);
    await deployLive(id, { commitSha: shaA.slice(0, 7) });
    expect(containerEnv(id).GIT_SHA).toBe(shaA);
  });

  test("a GIT_SHA of the service's own wins, also an empty one, and so does the project's shared one", async () => {
    const id = await createApp("api", gitSource);
    nodeChecksOut(shaA);
    const cases: [string | null, string | null, string][] = [
      ["GIT_SHA=v1.4.2\n", null, "v1.4.2"],
      ["GIT_SHA=\n", null, ""],
      [null, "GIT_SHA=from-shared\n", "from-shared"],
      ["GIT_SHA=own\n", "GIT_SHA=from-shared\n", "own"],
    ];
    for (const [own, shared, want] of cases) {
      writeServiceEnv(panel.deps.db, panel.deps.secrets, id, own ?? "", null);
      writeProjectEnv(panel.deps.db, panel.deps.secrets, projectId, shared ?? "", null);
      await deployLive(id);
      expect(containerEnv(id).GIT_SHA).toBe(want);
      // The node sees the same value in the build's variables, and so adds none of its own.
      expect(fleet.builds.at(-1)?.request.env).toContainEqual(expect.objectContaining({ name: "GIT_SHA", value: want }));
    }
  });

  test("a rollback runs with the commit of the deployment it runs again", async () => {
    const id = await createApp("api", gitSource);
    nodeChecksOut(shaA);
    const first = await deployLive(id);
    nodeChecksOut(shaB);
    await deployLive(id);
    expect(containerEnv(id).GIT_SHA).toBe(shaB);

    const rb = await callOp(panel, deploymentOps.rollback, { serviceId: id, deploymentId: first }, { cookie });
    expect(rb.status).toBe(200);
    await fleet.settle();
    expect(fleet.builds).toHaveLength(2);
    expect(containerEnv(id).GIT_SHA).toBe(shaA);
    await goLive(id, rb.body.id);
    expect(containerEnv(id).GIT_SHA).toBe(shaA);

    // A GIT_SHA the service sets by the time of the rollback still wins.
    writeServiceEnv(panel.deps.db, panel.deps.secrets, id, "GIT_SHA=pinned\n", null);
    const again = await callOp(panel, deploymentOps.rollback, { serviceId: id, deploymentId: first }, { cookie });
    expect(again.status).toBe(200);
    await fleet.settle();
    expect(containerEnv(id).GIT_SHA).toBe("pinned");
    await goLive(id, again.body.id);

    // Rolling back to that rollback, once the service's own is gone: the commit its image was built from.
    writeServiceEnv(panel.deps.db, panel.deps.secrets, id, "", null);
    nodeChecksOut(shaB);
    await deployLive(id);
    const back = await callOp(panel, deploymentOps.rollback, { serviceId: id, deploymentId: again.body.id }, { cookie });
    expect(back.status).toBe(200);
    await fleet.settle();
    expect(containerEnv(id).GIT_SHA).toBe(shaA);
  });

  test("an image gets none, whatever commit a deploy names", async () => {
    const image = await createApp("web", { type: "image", image: "nginx:1.27", registryId: null });
    await deployLive(image, { commitSha: shaA });
    expect(containerEnv(image).GIT_SHA).toBeUndefined();
  });

  test("an inline Dockerfile gets none, whatever commit a deploy names", async () => {
    const inline = await createApp("tool", { type: "inline" });
    const row = panel.deps.db.select().from(services).where(eq(services.id, inline)).get();
    panel.deps.db
      .update(services)
      .set({ spec: { ...(row?.spec as object), build: { builder: "dockerfile", inlineDockerfile: "FROM nginx:1.27\n" } } })
      .where(eq(services.id, inline))
      .run();
    // Nodes send no BuildSourceInfo for it: nothing was fetched from git.
    fleet.buildScript = () => ({ result: "succeeded", digest: `sha256:${"c".repeat(64)}` });
    await deployLive(inline, { commitSha: shaA });
    expect(containerEnv(inline).GIT_SHA).toBeUndefined();
  });

  test("a service running when the panel updates keeps its spec: GIT_SHA comes with its next deploy", async () => {
    const id = await createApp("api", gitSource);
    nodeChecksOut(shaA);
    const live = await deployLive(id);
    // As an older panel left the row: the commit recorded, the env sealed without GIT_SHA.
    panel.deps.db
      .update(deployments)
      .set({ envSealed: sealDeploymentEnv(panel.deps, id) })
      .where(eq(deployments.id, live))
      .run();
    const before = containerEnv(id);
    expect(before.GIT_SHA).toBeUndefined();

    // Nothing adds it to a deployment that already rolled out (a late or replayed report included):
    // its containers would be recreated.
    recordBuiltCommit(panel.deps, live, shaA);
    expect(containerEnv(id)).toEqual(before);
    const sealed = panel.deps.db.select().from(deployments).where(eq(deployments.id, live)).get()?.envSealed ?? null;
    expect(deploymentEnv(panel.deps, sealed)?.some((v) => v.name === "GIT_SHA")).toBe(false);

    nodeChecksOut(shaB);
    await deployLive(id);
    expect(containerEnv(id).GIT_SHA).toBe(shaB);
  });
});
