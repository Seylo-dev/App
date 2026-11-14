// A deploy says what it built from (Deployment.source) out of its own row,
// for its title when it has no commit message. The web used to fall back to
// the service's source as it is now, so every upload deploy read the newest
// archive's name, and a failed clone of branch "mian" read "Deploy from main"
// once the branch was fixed, right above "could not fetch mian".

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployments as deploymentOps, projects, services as serviceOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { services, sourceUploads } from "../src/db/schema";
import { queueDeploy } from "../src/modules/deployments/queue";
import { deploymentSource } from "../src/modules/deployments/store";
import { setTargetResolver } from "../src/modules/uptime/targets";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let nodeA: string;
let dir: string;

beforeEach(async () => {
  // gitea.lan is internal: the panel never lists its refs itself, so a manual deploy has no commit until the node clones.
  setTargetResolver(async (host) => {
    if (host === "gitea.lan") return ["10.0.0.7"];
    throw new Error("NXDOMAIN");
  });
  dir = mkdtempSync(join(tmpdir(), "seylo-deploy-source-"));
  mkdirSync(join(dir, "uploads"), { recursive: true });
  panel = testPanel();
  (panel.deps.config as { dataDir: string }).dataDir = dir;
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  fleet.addNode("builder", { canBuild: true, panelNode: true });
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
});
afterEach(() => {
  setTargetResolver(null);
  panel.close();
  rmSync(dir, { recursive: true, force: true });
});

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

function setSource(serviceId: string, source: Record<string, unknown>) {
  const spec = panel.deps.db.select().from(services).where(eq(services.id, serviceId)).get()?.spec as Record<string, unknown>;
  panel.deps.db
    .update(services)
    .set({ spec: { ...spec, source } })
    .where(eq(services.id, serviceId))
    .run();
}

async function deploy(serviceId: string) {
  const res = await callOp(panel, deploymentOps.deploy, { serviceId }, { cookie });
  expect(res.status).toBe(200);
  await fleet.settle();
  return res.body.id as string;
}

async function list(serviceId: string) {
  const res = await callOp(panel, deploymentOps.list, { serviceId, limit: 10 }, { cookie });
  expect(res.status).toBe(200);
  return res.body.deployments as { id: string; source: string | null; commit: unknown; status: string; error: string | null }[];
}

test("each upload deploy names its own archive, not the newest one", async () => {
  const id = await createApp("site", { type: "inline" });
  const upload = (fileName: string) => {
    const row = panel.deps.db
      .insert(sourceUploads)
      .values({ serviceId: id, fileName, sizeBytes: 4, sha256: "0".repeat(64) })
      .returning()
      .get();
    writeFileSync(join(dir, "uploads", `${row.id}.tar.gz`), "data");
    setSource(id, { type: "upload", fileName });
    return row.id;
  };
  const first = upload("app-v1.zip");
  const one = await deploy(id);
  // A new archive deploys as the upload route does: it queues behind the running deploy (a Deploy click would be refused).
  const second = upload("app-v2.zip");
  const two = queueDeploy(panel.deps, { serviceId: id, trigger: "manual", actor: null, uploadId: second }).id;

  expect((await list(id)).map((d) => [d.id, d.source])).toEqual([
    [two, "app-v2.zip"],
    [one, "app-v1.zip"],
  ]);
  // Older archives are deleted as new ones arrive: the clone step still has the name.
  panel.deps.db.delete(sourceUploads).where(eq(sourceUploads.id, first)).run();
  expect((await list(id)).find((d) => d.id === one)?.source).toBe("app-v1.zip");
});

test("a clone that failed before a commit keeps the branch it tried, after the branch is fixed", async () => {
  const id = await createApp("api", {
    type: "git",
    url: "https://gitea.lan/acme/api.git",
    branch: "mian",
    credentialId: null,
    deployOnPush: false,
  });
  fleet.buildScript = () => ({
    result: "failed",
    message: "could not fetch mian - check the address, the branch and the credentials (exit status 128)",
  });
  const failed = await deploy(id);
  setSource(id, { type: "git", url: "https://gitea.lan/acme/api.git", branch: "main", credentialId: null, deployOnPush: false });

  const [row] = await list(id);
  expect(row).toMatchObject({ id: failed, status: "failed", commit: null, source: "mian" });
  expect(row?.error).toContain("could not fetch mian");
  expect(fleet.builds).toHaveLength(1);
});

// The web's hint under such a deploy (CloneNetworkHint) links the node it names, the build node (builtOn).
test("a clone that failed on the node's network shows the agent's words: the node, the host, the Health check", async () => {
  const id = await createApp("api", {
    type: "git",
    url: "https://gitea.lan/acme/api.git",
    branch: "main",
    credentialId: null,
    deployOnPush: false,
  });
  // build.GitNetworkError: the fetch's proxy could not connect, git only saw "CONNECT tunnel failed, response 502".
  const message =
    "fetching the source failed: node builder could not connect to gitea.lan:443 - a network problem on the node, not the address, " +
    "the branch or the credentials: dial tcp 10.0.0.7:443: i/o timeout (git exited with code 128). " +
    "The node's Health check (its Health tab, or `seylo health` on the node) tests its DNS and connections";
  fleet.buildScript = () => ({ result: "failed", message });
  const failed = await deploy(id);

  const [row] = await list(id);
  expect(row).toMatchObject({ id: failed, status: "failed" });
  expect(row?.error).toBe(`The build failed: ${message}`);
  expect(row?.error).not.toContain("check the address");
  const res = await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: failed }, { cookie });
  expect(res.body.deployment).toMatchObject({ error: `The build failed: ${message}`, builtOn: { name: "builder" } });
});

test("what a deploy built from comes from its own row", () => {
  const archives = new Map([["up1", "app-v1.zip"]]);
  const clone = (status: "ok" | "failed", detail: string) => [{ key: "clone" as const, status, nodeId: null, detail, durationMs: 1 }];
  expect(deploymentSource({ branch: "release", uploadId: null, steps: [] }, archives)).toBe("release");
  expect(deploymentSource({ branch: null, uploadId: "up1", steps: [] }, archives)).toBe("app-v1.zip");
  expect(deploymentSource({ branch: null, uploadId: "gone", steps: clone("ok", "app-v0.zip") }, archives)).toBe("app-v0.zip");
  // A clone that failed holds its error, not the name.
  expect(deploymentSource({ branch: null, uploadId: "gone", steps: clone("failed", "bad archive") }, archives)).toBeNull();
  // Image deploys, rollbacks and inline Dockerfiles record neither.
  expect(deploymentSource({ branch: null, uploadId: null, steps: clone("ok", "Inline Dockerfile") }, archives)).toBeNull();
});
