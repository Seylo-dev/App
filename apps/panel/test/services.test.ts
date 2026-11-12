import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { builds, deployments as deploymentOps, exposures, git, projects, registries, services as serviceOps } from "@seylo/ops";
import { DeployStage } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { servicePlacements, services } from "../src/db/schema";
import { parseAdvertisement } from "../src/modules/git/remote";
import { serviceSpecFor } from "../src/modules/services/desired";
import { moveJob } from "../src/modules/services/move";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let nodeA: string;
let nodeB: string;

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  nodeB = fleet.addNode("node-b");
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
});
afterEach(() => panel.close());

async function liveImageService(name: string, volumes: { name: string; mountPath: string }[] = []) {
  const id = (
    await callOp(
      panel,
      serviceOps.create,
      {
        projectId,
        name,
        kind: "app",
        nodeId: nodeA,
        source: { type: "image", image: "redis:7", registryId: null },
        ports: [{ containerPort: 6379, protocol: "tcp" }],
      },
      { cookie },
    )
  ).body.id as string;
  if (volumes.length > 0) expect((await callOp(panel, serviceOps.setVolumes, { serviceId: id, volumes }, { cookie })).status).toBe(200);
  const dep = (await callOp(panel, deploymentOps.deploy, { serviceId: id }, { cookie })).body;
  await fleet.settle();
  fleet.deployProgress(nodeA, id, dep.generation, DeployStage.SUCCEEDED);
  await fleet.settle();
  return id;
}

describe("service settings", () => {
  test("an app created without a port gets first-run IP:port when its port is set", async () => {
    const created = await callOp(panel, serviceOps.create, { projectId, name: "late", kind: "app", nodeId: nodeA }, { cookie });
    const id = created.body.id;
    const before = await callOp(panel, exposures.get, { serviceId: id }, { cookie });
    expect(before.body.firstRun.status).not.toBe("open");
    await callOp(panel, serviceOps.update, { serviceId: id, ports: [{ containerPort: 8080, protocol: "tcp" }] }, { cookie });
    const after = await callOp(panel, exposures.get, { serviceId: id }, { cookie });
    expect(after.body.firstRun.status).toBe("open");
  });

  test("create, read, update, notes, health check, crash policy and resources", async () => {
    const created = await callOp(panel, serviceOps.create, { projectId, name: "api", kind: "app", nodeId: nodeA }, { cookie });
    expect(created.body).toMatchObject({
      name: "api",
      status: "idle",
      sourceConfig: { type: "none" },
      generation: 1,
      restartDelaySeconds: 5,
      volumes: [],
    });
    const id = created.body.id;

    const dupe = await callOp(panel, serviceOps.create, { projectId, name: "api", kind: "app", nodeId: nodeA }, { cookie });
    expect(dupe.body.error).toMatchObject({ code: "CONFLICT", details: { field: "name" } });

    const renamed = await callOp(
      panel,
      serviceOps.update,
      { serviceId: id, name: "api-v2", ports: [{ containerPort: 8080, protocol: "tcp" }], container: { command: ["node", "server.js"] } },
      { cookie },
    );
    expect(renamed.body).toMatchObject({
      name: "api-v2",
      ports: [{ containerPort: 8080 }],
      container: { command: ["node", "server.js"], stopGraceSeconds: 10 },
      address: "api-v2:8080",
    });

    const notes = await callOp(panel, serviceOps.setNotes, { serviceId: id, notes: "# Hello" }, { cookie });
    expect(notes.body.notes).toBe("# Hello");
    const hc = await callOp(
      panel,
      serviceOps.setHealthCheck,
      {
        serviceId: id,
        healthCheck: {
          probe: { type: "http", port: 8080, path: "/health", host: "", expectedStatus: 0 },
          intervalSeconds: 5,
          timeoutSeconds: 2,
          startPeriodSeconds: 0,
          failureThreshold: 3,
        },
        deploy: { mode: "recreate", healthTimeoutSeconds: 60 },
      },
      { cookie },
    );
    expect(hc.body.deploy).toEqual({ mode: "recreate", healthTimeoutSeconds: 60 });
    const crash = await callOp(panel, serviceOps.setCrashPolicy, { serviceId: id, restart: true, stopAfterCrashes: 3 }, { cookie });
    expect(crash.body).toEqual({ crashPolicy: { restart: true, stopAfterCrashes: 3 }, restartDelaySeconds: 5 });
    const res = await callOp(
      panel,
      serviceOps.setResources,
      { serviceId: id, memoryLimitBytes: 256 * 1024 * 1024, memoryReservationBytes: null, cpuWeight: 50, pidsLimit: null },
      { cookie },
    );
    expect(res.body.cpuWeight).toBe(50);

    const list = await callOp(panel, serviceOps.list, { projectId }, { cookie });
    expect(list.body.services.map((s: { name: string }) => s.name)).toEqual(["api-v2"]);
    const build = await callOp(panel, builds.getSettings, { serviceId: id }, { cookie });
    expect(build.body.settings.builder).toBe("railpack");
    expect(build.body.nodes.map((n: { name: string }) => n.name)).toEqual(["node-a", "node-b"]);
    const noBuild = await callOp(panel, builds.updateSettings, { serviceId: id, buildNodeId: nodeB }, { cookie });
    expect(noBuild.body.error.code).toBe("BAD_REQUEST");
  });

  test("settings reach the node only on the next deploy; the crash policy right away", async () => {
    const id = await liveImageService("cache");
    await callOp(panel, serviceOps.update, { serviceId: id, ports: [{ containerPort: 7000, protocol: "tcp" }] }, { cookie });
    await callOp(panel, serviceOps.setCrashPolicy, { serviceId: id, restart: false, stopAfterCrashes: 0 }, { cookie });
    const spec = serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA);
    expect(spec?.ports[0]?.containerPort).toBe(6379);
    expect(spec?.crashPolicy?.restart).toBe(false);
  });

  test("members without the grant cannot read; a service grant is enough to view", async () => {
    const id = await liveImageService("cache");
    const { user, cookie: memberCookie } = await createUser(panel, "member");
    expect((await callOp(panel, serviceOps.get, { serviceId: id }, { cookie: memberCookie })).status).toBe(403);
    grant(panel, user.id, "service", id, ["services.view"]);
    expect((await callOp(panel, serviceOps.get, { serviceId: id }, { cookie: memberCookie })).status).toBe(200);
    expect((await callOp(panel, serviceOps.stop, { serviceId: id }, { cookie: memberCookie })).status).toBe(403);
  });

  test("stop, start and restart", async () => {
    const id = await liveImageService("cache");
    await callOp(panel, serviceOps.stop, { serviceId: id }, { cookie });
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.stopped).toBe(true);
    expect((await callOp(panel, serviceOps.get, { serviceId: id }, { cookie })).body.status).toBe("stopped");
    await callOp(panel, serviceOps.start, { serviceId: id }, { cookie });
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.stopped).toBe(false);
    const restarted = await callOp(panel, serviceOps.restart, { serviceId: id }, { cookie });
    expect(restarted.status).toBe(200);
    expect(fleet.calls.filter((c) => c.method === "restartService")).toEqual([
      { nodeId: nodeA, method: "restartService", request: { serviceId: id } },
    ]);
  });

  test("replicas per node load balance across nodes; volumes keep a service on one node", async () => {
    const id = await liveImageService("web");
    const res = await callOp(
      panel,
      serviceOps.setPlacements,
      {
        serviceId: id,
        placements: [
          { nodeId: nodeA, replicas: 2 },
          { nodeId: nodeB, replicas: 1 },
        ],
        stickySessions: true,
      },
      { cookie },
    );
    expect(res.status).toBe(200);
    const onA = serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA);
    expect(onA?.replicas).toBe(2);
    expect(onA?.loadBalancer).toMatchObject({ stickySessions: true, remoteUpstreams: [{ nodeId: nodeB }] });
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeB)?.replicas).toBe(1);
    expect(res.body.entryNodeId).toBeNull();
    // Without an entry node both balance; with one only it does.
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeB)?.loadBalancer?.remoteUpstreams).toMatchObject([{ nodeId: nodeA }]);
    const entry = await callOp(
      panel,
      serviceOps.setPlacements,
      {
        serviceId: id,
        placements: [
          { nodeId: nodeA, replicas: 2 },
          { nodeId: nodeB, replicas: 1 },
        ],
        entryNodeId: nodeB,
      },
      { cookie },
    );
    expect(entry.body).toMatchObject({ entryNodeId: nodeB, stickySessions: true });
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.loadBalancer?.remoteUpstreams).toEqual([]);
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeB)?.loadBalancer?.remoteUpstreams).toMatchObject([{ nodeId: nodeA }]);
    expect((await callOp(panel, serviceOps.get, { serviceId: id }, { cookie })).body.entryNodeId).toBe(nodeB);
    const outside = await callOp(
      panel,
      serviceOps.setPlacements,
      { serviceId: id, placements: [{ nodeId: nodeA, replicas: 1 }], entryNodeId: nodeB },
      { cookie },
    );
    expect(outside.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "entryNodeId" } });
    // Down to one node: nothing to balance, so no entry node.
    const single = await callOp(
      panel,
      serviceOps.setPlacements,
      { serviceId: id, placements: [{ nodeId: nodeB, replicas: 1 }] },
      { cookie },
    );
    expect(single.body.entryNodeId).toBeNull();

    const withData = await liveImageService("db", [{ name: "data", mountPath: "/data" }]);
    const refused = await callOp(
      panel,
      serviceOps.setPlacements,
      {
        serviceId: withData,
        placements: [
          { nodeId: nodeA, replicas: 1 },
          { nodeId: nodeB, replicas: 1 },
        ],
      },
      { cookie },
    );
    expect(refused.body.error.code).toBe("CONFLICT");
    const vols = (await callOp(panel, serviceOps.get, { serviceId: withData }, { cookie })).body.volumes;
    expect(vols).toMatchObject([{ name: "data", mountPath: "/data", kind: "volume", readOnly: false, sharedWith: [] }]);
  });

  test("delete needs the exact name and removes the rows", async () => {
    const id = await liveImageService("cache");
    expect((await callOp(panel, serviceOps.remove, { serviceId: id, confirmName: "nope" }, { cookie })).body.error.code).toBe(
      "BAD_REQUEST",
    );
    expect((await callOp(panel, serviceOps.remove, { serviceId: id, confirmName: "cache" }, { cookie })).status).toBe(200);
    expect(panel.deps.db.select().from(services).where(eq(services.id, id)).get()).toBeUndefined();
    expect((await callOp(panel, projects.remove, { projectId, confirmName: "shop" }, { cookie })).status).toBe(200);
  });
});

describe("moving services", () => {
  test("without volumes: rolls out on both nodes, then the old placement goes", async () => {
    const id = await liveImageService("web");
    const res = await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie });
    expect(res.status).toBe(200);
    await fleet.settle();
    const d = (await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: res.body.deploymentId }, { cookie })).body.deployment;
    expect(d).toMatchObject({ trigger: "move", status: "deploying" });
    expect(d.shippedTo.map((n: { name: string }) => n.name).sort()).toEqual(["node-a", "node-b"]);
    fleet.deployProgress(nodeA, id, d.generation, DeployStage.SUCCEEDED);
    fleet.deployProgress(nodeB, id, d.generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    const placements = panel.deps.db.select().from(servicePlacements).where(eq(servicePlacements.serviceId, id)).all();
    expect(placements.map((p) => p.nodeId)).toEqual([nodeB]);
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)).toBeNull();
  });

  test("with volumes: stops, copies each volume through the panel, then starts on the new node", async () => {
    const id = await liveImageService("db", [{ name: "data", mountPath: "/data" }]);
    fleet.volumes.set(nodeA, new Map([[`${id}/data`, new TextEncoder().encode("tar.gz bytes of the volume")]]));
    fleet.reportRunning(nodeA, id, 1, "", 8 /* STOPPED */);
    // What the new node's desired state says about the service while the copy fills its folder.
    let duringCopy: ReturnType<typeof serviceSpecFor> | undefined;
    const openRaw = fleet.hub.openRaw.bind(fleet.hub);
    fleet.hub.openRaw = ((nodeId: string, method: string, request: unknown) => {
      if (nodeId === nodeB && method === "importVolume") duringCopy = serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeB);
      return openRaw(nodeId as never, method as never, request as never);
    }) as typeof fleet.hub.openRaw;
    const res = await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie });
    expect(res.status).toBe(200);
    await panel.runner.runDue(panel.deps);
    await fleet.settle();
    expect(new TextDecoder().decode(fleet.volumes.get(nodeB)?.get(`${id}/data`))).toBe("tar.gz bytes of the volume");
    // Placed there and stopped before the copy began, so the new node's cleanup never takes the
    // folder being filled for an orphan's.
    expect(duringCopy?.stopped).toBe(true);
    const placed = () =>
      panel.deps.db
        .select()
        .from(servicePlacements)
        .where(eq(servicePlacements.serviceId, id))
        .all()
        .map((p) => p.nodeId)
        .sort();
    // The old node keeps a stopped copy (and its data) until the new one is live.
    expect(placed()).toEqual([nodeA, nodeB].sort());
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.stopped).toBe(true);
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeB)?.stopped).toBe(false);
    const d = (await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: res.body.deploymentId }, { cookie })).body.deployment;
    expect(d.status).toBe("deploying");
    expect(d.shippedTo.map((n: { id: string }) => n.id)).toEqual([nodeB]);
    fleet.deployProgress(nodeB, id, d.generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    expect(
      (await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: res.body.deploymentId }, { cookie })).body.deployment.status,
    ).toBe("live");
    expect(placed()).toEqual([nodeB]);
    expect(moveJob.type).toBe("services.move");
  });

  test("a failed move with volumes leaves the data and the service on the old node", async () => {
    const id = await liveImageService("db", [{ name: "data", mountPath: "/data" }]);
    fleet.reportRunning(nodeA, id, 1, "", 8 /* STOPPED */);
    const res = await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie });
    await panel.runner.runDue(panel.deps);
    await fleet.settle();
    const d = (await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: res.body.deploymentId }, { cookie })).body.deployment;
    fleet.deployProgress(nodeB, id, d.generation, DeployStage.FAILED, "no database host");
    await fleet.settle();
    expect(
      panel.deps.db
        .select()
        .from(servicePlacements)
        .where(eq(servicePlacements.serviceId, id))
        .all()
        .map((p) => p.nodeId),
    ).toEqual([nodeA]);
    const spec = serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA);
    expect(spec?.stopped).toBe(false);
    expect(spec?.generation).toBe(1n);
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeB)).toBeNull();
  });

  test("while a move copies the volumes the service runs on neither node and nothing can change that", async () => {
    const id = await liveImageService("db", [{ name: "data", mountPath: "/data" }]);
    fleet.volumes.set(nodeA, new Map([[`${id}/data`, new TextEncoder().encode("tar.gz bytes of the volume")]]));
    fleet.reportRunning(nodeA, id, 1, "", 8 /* STOPPED */);
    const seen: Record<string, unknown> = {};
    let during: Promise<void> | undefined;
    const openRaw = fleet.hub.openRaw.bind(fleet.hub);
    fleet.hub.openRaw = ((nodeId: string, method: string, request: unknown) => {
      const raw = openRaw(nodeId as never, method as never, request as never);
      if (nodeId !== nodeB || method !== "importVolume") return raw;
      // Everything below runs while the import is still writing: the copy waits for it to end.
      during = (async () => {
        const start = await callOp(panel, serviceOps.start, { serviceId: id }, { cookie });
        seen.start = [start.status, start.body.error?.details?.reason];
        const onlyNew = await callOp(
          panel,
          serviceOps.setPlacements,
          { serviceId: id, placements: [{ nodeId: nodeB, replicas: 1 }] },
          { cookie },
        );
        seen.onlyNew = [onlyNew.status, onlyNew.body.error?.details?.reason];
        const onlyOld = await callOp(
          panel,
          serviceOps.setPlacements,
          { serviceId: id, placements: [{ nodeId: nodeA, replicas: 1 }] },
          { cookie },
        );
        seen.onlyOld = [onlyOld.status, onlyOld.body.error?.details?.reason];
        const vols = await callOp(panel, serviceOps.setVolumes, { serviceId: id, volumes: [] }, { cookie });
        seen.volumes = [vols.status, vols.body.error?.details?.reason];
        const clone = await callOp(panel, serviceOps.clone, { serviceId: id, projectId, nodeId: nodeA, data: "copy" }, { cookie });
        seen.clone = [clone.status, clone.body.error?.details?.reason];
        seen.placements = panel.deps.db
          .select()
          .from(servicePlacements)
          .where(eq(servicePlacements.serviceId, id))
          .all()
          .map((p) => p.nodeId)
          .sort();
        // Whatever else clears `stopped` meanwhile, neither node runs it before the copy is done.
        panel.deps.db.update(services).set({ stopped: false }).where(eq(services.id, id)).run();
        seen.newStopped = serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeB)?.stopped;
        seen.oldStopped = serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.stopped;
      })();
      const response = raw.response.then(async (r: unknown) => {
        await during;
        return r;
      });
      return { ...raw, response } as typeof raw;
    }) as typeof fleet.hub.openRaw;
    const res = await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie });
    expect(res.status).toBe(200);
    await panel.runner.runDue(panel.deps);
    await fleet.settle();
    expect(during).toBeDefined();
    await during;
    expect(seen).toEqual({
      start: [409, "moving"],
      onlyNew: [409, "moving"],
      onlyOld: [409, "moving"],
      volumes: [409, "moving"],
      clone: [409, "moving"],
      placements: [nodeA, nodeB].sort(),
      newStopped: true,
      oldStopped: true,
    });
    // The copy ends: the move goes on and starts it on the new node only.
    expect(new TextDecoder().decode(fleet.volumes.get(nodeB)?.get(`${id}/data`))).toBe("tar.gz bytes of the volume");
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeB)?.stopped).toBe(false);
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.stopped).toBe(true);
  });

  test("a move with volumes whose copy fails takes the stopped placement off the new node", async () => {
    const id = await liveImageService("db", [{ name: "data", mountPath: "/data" }]);
    fleet.reportRunning(nodeA, id, 1, "", 8 /* STOPPED */);
    const res = await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie });
    expect(res.status).toBe(200);
    // The old node drops off before the copy can start.
    fleet.online.delete(nodeA);
    await panel.runner.runDue(panel.deps);
    await fleet.settle();
    const d = (await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: res.body.deploymentId }, { cookie })).body.deployment;
    expect(d.status).toBe("failed");
    expect(
      panel.deps.db
        .select()
        .from(servicePlacements)
        .where(eq(servicePlacements.serviceId, id))
        .all()
        .map((p) => p.nodeId),
    ).toEqual([nodeA]);
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeB)).toBeNull();
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.stopped).toBe(false);
  });

  test("a failed move puts the service back on its node", async () => {
    const id = await liveImageService("web");
    const res = await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie });
    await fleet.settle();
    const d = (await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: res.body.deploymentId }, { cookie })).body.deployment;
    fleet.deployProgress(nodeB, id, d.generation, DeployStage.FAILED, "port 6379 closed");
    await fleet.settle();
    expect(
      panel.deps.db
        .select()
        .from(servicePlacements)
        .where(eq(servicePlacements.serviceId, id))
        .all()
        .map((p) => p.nodeId),
    ).toEqual([nodeA]);
    expect(
      (await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: res.body.deploymentId }, { cookie })).body.deployment.status,
    ).toBe("failed");
  });
});

describe("git and registry credentials", () => {
  test("generated SSH keys and tokens are sealed and never returned", async () => {
    const key = await callOp(panel, git.generateSshKey, { name: "deploy", host: "git.example.com" }, { cookie });
    expect(key.body).toMatchObject({ kind: "ssh_key", origin: "generated", host: "git.example.com" });
    expect(key.body.publicKey).toStartWith("ssh-ed25519 ");
    expect(key.body.fingerprint).toStartWith("SHA256:");
    const token = await callOp(
      panel,
      git.createCredential,
      { name: "gl", kind: "token", host: "gitlab.com", token: "glpat-secret" },
      { cookie },
    );
    expect(JSON.stringify(token.body)).not.toContain("glpat-secret");
    const list = await callOp(panel, git.listCredentials, {}, { cookie });
    expect(list.body.items.map((c: { name: string }) => c.name)).toEqual(["deploy", "gl"]);
    const svc = await callOp(
      panel,
      serviceOps.create,
      {
        projectId,
        name: "app",
        kind: "app",
        nodeId: nodeA,
        source: { type: "git", url: "https://gitlab.com/a/b.git", branch: "main", credentialId: token.body.id, deployOnPush: false },
      },
      { cookie },
    );
    expect(svc.status).toBe(200);
    expect((await callOp(panel, git.deleteCredential, { credentialId: token.body.id }, { cookie })).body.error.code).toBe("CONFLICT");
    expect(
      (await callOp(panel, git.listCredentials, {}, { cookie })).body.items.find((c: { id: string }) => c.id === token.body.id).usedBy,
    ).toBe(1);
  });

  test("ref advertisements are parsed with the default branch first", () => {
    const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
    const body =
      pkt("# service=git-upload-pack\n") +
      "0000" +
      pkt(`${"a".repeat(40)} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=git/2\n`) +
      pkt(`${"b".repeat(40)} refs/heads/dev\n`) +
      pkt(`${"a".repeat(40)} refs/heads/main\n`) +
      pkt(`${"c".repeat(40)} refs/tags/v1\n`) +
      "0000";
    const refs = parseAdvertisement(new TextEncoder().encode(body));
    expect(refs.defaultBranch).toBe("main");
    expect(refs.branches).toEqual(["main", "dev"]);
    expect(refs.heads.get("dev")).toBe("b".repeat(40));
  });

  test("git.branches reads a smart-HTTP repository", async () => {
    const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
    // On 127.0.0.1, the address the URL names (see fix-backup-signing.test.ts).
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (!new URL(req.url).pathname.endsWith("/info/refs")) return new Response("no", { status: 404 });
        if (req.headers.get("authorization") !== `Basic ${btoa("x-access-token:tok")}`) return new Response("auth", { status: 401 });
        return new Response(
          pkt("# service=git-upload-pack\n") +
            "0000" +
            pkt(`${"a".repeat(40)} HEAD\0symref=HEAD:refs/heads/trunk\n`) +
            pkt(`${"a".repeat(40)} refs/heads/trunk\n`) +
            "0000",
          {
            headers: { "content-type": "application/x-git-upload-pack-advertisement" },
          },
        );
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/team/app.git`;
      const { listRemoteRefs } = await import("../src/modules/git/remote");
      await expect(listRemoteRefs(url)).rejects.toThrow("private");
      const refs = await listRemoteRefs(url, { token: "tok" });
      expect(refs.branches).toEqual(["trunk"]);
    } finally {
      server.stop(true);
    }
  });

  test("registry logins are checked before they are stored", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.host === "registry.example.com" && url.pathname === "/v2/") {
        const auth = new Headers(init?.headers).get("authorization");
        if (!auth)
          return new Response("", {
            status: 401,
            headers: { "www-authenticate": 'Bearer realm="https://auth.example.com/token",service="registry.example.com"' },
          });
      }
      if (url.host === "auth.example.com") {
        const auth = new Headers(init?.headers).get("authorization");
        return new Response("{}", { status: auth === `Basic ${btoa("bot:good")}` ? 200 : 401 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const bad = await callOp(
        panel,
        registries.create,
        { name: "r", server: "registry.example.com", username: "bot", password: "bad" },
        { cookie },
      );
      expect(bad.body.error).toMatchObject({ code: "BAD_REQUEST", message: "The user name or password is wrong." });
      const good = await callOp(
        panel,
        registries.create,
        { name: "r", server: "registry.example.com", username: "bot", password: "good" },
        { cookie },
      );
      expect(good.body).toMatchObject({ name: "r", server: "registry.example.com", username: "bot", usedBy: 0 });
      expect((await callOp(panel, registries.test, { registryId: good.body.id }, { cookie })).body).toEqual({ ok: true, error: null });

      const id = (
        await callOp(
          panel,
          serviceOps.create,
          {
            projectId,
            name: "priv",
            kind: "app",
            nodeId: nodeA,
            source: { type: "image", image: "registry.example.com/a:1", registryId: good.body.id },
          },
          { cookie },
        )
      ).body.id;
      const dep = (await callOp(panel, deploymentOps.deploy, { serviceId: id }, { cookie })).body;
      await fleet.settle();
      expect(dep.status).toBe("queued");
      expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.image?.auth).toMatchObject({
        server: "registry.example.com",
        username: "bot",
        password: "good",
      });
      expect((await callOp(panel, registries.remove, { registryId: good.body.id }, { cookie })).body.error.code).toBe("CONFLICT");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
