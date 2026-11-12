// The installer's panel as a protected service: rows with the reserved ids
// once the panel node exists (and on its first connect), the desired spec
// that lets the agent adopt the installer's container, guards against
// deploying or stopping it, and the image row after a panel update.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { deployments as deploymentOps, services as serviceOps } from "@seylo/ops";
import { DeployMode, HttpsMode, PublicPortMode } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { deployments, nodes, projects, servicePlacements, services, updateRuns, updateSteps } from "../src/db/schema";
import { compileDesiredState } from "../src/desired";
import { ensurePanelService, panelProjectId, panelServiceId, splitImage, syncPanelImage } from "../src/modules/nodes/panel-service";
import { setSetting } from "../src/settings";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { fakeAgent } from "./seed-helpers";

const digest = `sha256:${"a".repeat(64)}`;
const newDigest = `sha256:${"b".repeat(64)}`;
let panel: TestPanel;

function addPanelNode(isPanelNode = true) {
  return panel.deps.db
    .insert(nodes)
    .values({ name: "here", publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))), publicIpv4: "203.0.113.5", isPanelNode })
    .returning()
    .get().id;
}

function compile(nodeId: string) {
  const state = compileDesiredState(panel.deps.db, nodeId, {
    revision: 1n,
    secrets: panel.deps.secrets,
    contributors: panel.deps.agents.desired.contributors(),
  });
  return state.services.find((s) => s.id === panelServiceId);
}

beforeEach(() => {
  panel = testPanel();
  panel.deps.config.image = `ghcr.io/seylo-dev/seylo:0.1.0@${digest}`;
  panel.deps.config.hostPort = 8443;
  panel.deps.config.version = "0.1.0";
});
afterEach(() => panel.close());

test("image references split into reference and digest", () => {
  expect(splitImage(`ghcr.io/x/seylo:0.1.0@${digest}`)).toEqual({ reference: "ghcr.io/x/seylo:0.1.0", digest });
  expect(splitImage("ghcr.io/x/seylo:0.1.0")).toEqual({ reference: "ghcr.io/x/seylo:0.1.0", digest: null });
});

test("nothing happens without an installed image or a panel node", () => {
  panel.deps.config.image = null;
  addPanelNode();
  expect(ensurePanelService(panel.deps)).toBe("skipped");
  panel.deps.config.image = "ghcr.io/seylo-dev/seylo:0.1.0";
  panel.deps.db.update(nodes).set({ isPanelNode: false }).run();
  expect(ensurePanelService(panel.deps)).toBe("skipped");
  expect(panel.deps.db.select().from(services).all()).toEqual([]);
});

test("the panel node gets the reserved rows and a spec the agent adopts as is", () => {
  const nodeId = addPanelNode();
  expect(ensurePanelService(panel.deps)).toBe("created");
  expect(ensurePanelService(panel.deps)).toBe("unchanged");

  expect(panel.deps.db.select().from(projects).where(eq(projects.id, panelProjectId)).get()).toMatchObject({
    name: "Panel",
    protected: true,
  });
  const svc = panel.deps.db.select().from(services).where(eq(services.id, panelServiceId)).get();
  expect(svc).toMatchObject({ name: "panel", kind: "app", protected: true, generation: 1, projectId: panelProjectId });
  expect(panel.deps.db.select().from(servicePlacements).where(eq(servicePlacements.serviceId, panelServiceId)).all()).toMatchObject([
    { nodeId, replicas: 1 },
  ]);
  const live = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, panelServiceId)).all();
  expect(live).toMatchObject([{ generation: 1, status: "live", imageRef: "ghcr.io/seylo-dev/seylo:0.1.0", imageDigest: digest }]);

  const spec = compile(nodeId);
  expect(spec).toMatchObject({
    id: panelServiceId,
    projectId: panelProjectId,
    name: "panel",
    protected: true,
    generation: 1n,
    image: { reference: "ghcr.io/seylo-dev/seylo:0.1.0", digest },
    networkAliases: ["panel"],
    volumes: [],
    replicas: 1,
  });
  expect(spec?.deploy?.mode).toBe(DeployMode.RECREATE);
  expect(spec?.env.map((e) => `${e.name}=${e.value}`)).toEqual(["SEYLO_PORT=3000", "SEYLO_HOST_PORT=8443", "SEYLO_SECURE_COOKIES=false"]);
  expect(spec?.ports).toMatchObject([{ containerPort: 3000, public: { hostPort: 8443, mode: PublicPortMode.FORWARD } }]);
  expect(spec?.routing?.routes).toEqual([]);

  // With a panel domain, the domain routes to the panel. It answers Let's Encrypt's challenge on 443 too
  // (0.2.12): the panel's domain may be behind Cloudflare's proxy with a redirect to https for every path,
  // and the panel answers no challenge itself.
  setSetting(panel.deps.db, "panelDomain", "panel.example.com");
  expect(compile(nodeId)?.routing?.routes).toMatchObject([
    {
      id: panelServiceId,
      hosts: ["panel.example.com"],
      targetPort: 3000,
      https: HttpsMode.ACME,
      redirectToHttps: true,
      acmeChallengeOnHttps: true,
    },
  ]);
});

test("the first connect of the installer's agent records the panel", () => {
  const nodeId = addPanelNode();
  const agent = fakeAgent(panel, nodeId);
  expect(panel.deps.db.select().from(services).where(eq(services.id, panelServiceId)).get()?.protected).toBe(true);
  expect(panel.deps.agents.desired.takeDirty()).toContainEqual({ serviceId: panelServiceId });
  agent.disconnect();
});

test("the panel cannot be deployed, stopped or spread over nodes like an app", async () => {
  const nodeId = addPanelNode();
  ensurePanelService(panel.deps);
  const { cookie } = await createUser(panel, "owner");
  const deploy = await callOp(panel, deploymentOps.deploy, { serviceId: panelServiceId }, { cookie });
  expect(deploy.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "panel" } });
  const stop = await callOp(panel, serviceOps.stop, { serviceId: panelServiceId }, { cookie });
  expect(stop.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "panel" } });
  const spread = await callOp(
    panel,
    serviceOps.setPlacements,
    { serviceId: panelServiceId, placements: [{ nodeId, replicas: 2 }] },
    { cookie },
  );
  expect(spread.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "panel" } });
  const remove = await callOp(panel, serviceOps.remove, { serviceId: panelServiceId, confirmName: "panel" }, { cookie });
  expect(remove.body.error.code).toBe("CONFLICT");
});

test("after a panel update the new image is recorded at the next generation, once", () => {
  addPanelNode();
  ensurePanelService(panel.deps);
  // The update run that swapped this panel in: release 0.2.0, panel step running.
  const manifest = { version: "0.2.0", panel: { image: "ghcr.io/seylo-dev/seylo:0.2.0", digest: newDigest } };
  setSetting(panel.deps.db, "updateCheck", {
    checkedAt: new Date().toISOString(),
    latestVersion: "0.2.0",
    changelogUrl: null,
    error: null,
    manifestBase64: Buffer.from(JSON.stringify(manifest)).toString("base64"),
    signatureBase64: "c2ln",
  });
  const run = panel.deps.db.insert(updateRuns).values({ targetVersion: "0.2.0", trigger: "manual" }).returning().get();
  panel.deps.db
    .insert(updateSteps)
    .values({ runId: run.id, position: 0, target: "panel", fromVersion: "0.1.0", toVersion: "0.2.0", status: "running" })
    .run();

  // Still the old panel (a rollback restored it, or the swap has not happened): nothing changes.
  expect(syncPanelImage(panel.deps)).toBe(false);

  // The swapped-in container runs the stored spec's env, which carries no image variable.
  panel.deps.config.version = "0.2.0";
  panel.deps.config.image = null;
  expect(ensurePanelService(panel.deps)).toBe("updated");
  expect(ensurePanelService(panel.deps)).toBe("unchanged");
  const rows = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, panelServiceId)).all();
  expect(rows.map((r) => [r.generation, r.status, r.imageDigest])).toEqual([
    [1, "superseded", digest],
    [2, "live", newDigest],
  ]);
  const svc = panel.deps.db.select().from(services).where(eq(services.id, panelServiceId)).get();
  expect(svc?.generation).toBe(2);
  const spec = compile(panel.deps.db.select().from(nodes).get()?.id ?? "");
  expect(spec).toMatchObject({ generation: 2n, image: { reference: "ghcr.io/seylo-dev/seylo:0.2.0", digest: newDigest } });
});

test("the image comes from the run's own manifest: a check or channel switch during the panel step changes nothing", () => {
  const nodeId = addPanelNode();
  ensurePanelService(panel.deps);
  // The owner, on the pre-release channel, started the update to 0.2.0-rc.2:
  // the run keeps its manifest, its panel step is running.
  const rc = { version: "0.2.0-rc.2", panel: { image: "ghcr.io/seylo-dev/seylo:0.2.0-rc.2", digest: newDigest } };
  const run = panel.deps.db
    .insert(updateRuns)
    .values({
      targetVersion: "0.2.0-rc.2",
      trigger: "manual",
      manifest: Buffer.from(JSON.stringify(rc)).toString("base64"),
      manifestSignature: "c2ln",
    })
    .returning()
    .get();
  panel.deps.db
    .insert(updateSteps)
    .values({ runId: run.id, position: 0, target: "panel", fromVersion: "0.1.0", toVersion: "0.2.0-rc.2", status: "running" })
    .run();
  // While the image pulled the channel went back to stable (updates.setChannel
  // checks at once), or "Check now" ran: the stored check names 0.1.0 again.
  const stable = { version: "0.1.0", panel: { image: "ghcr.io/seylo-dev/seylo:0.1.0", digest } };
  setSetting(panel.deps.db, "updateCheck", {
    checkedAt: new Date().toISOString(),
    latestVersion: "0.1.0",
    changelogUrl: null,
    error: null,
    channel: "stable",
    manifestBase64: Buffer.from(JSON.stringify(stable)).toString("base64"),
    signatureBase64: "c2ln",
  });

  // The swapped-in rc.2 panel boots.
  panel.deps.config.version = "0.2.0-rc.2";
  panel.deps.config.image = null;
  expect(ensurePanelService(panel.deps)).toBe("updated");
  const rows = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, panelServiceId)).all();
  expect(rows.map((r) => [r.generation, r.status, r.imageDigest])).toEqual([
    [1, "superseded", digest],
    [2, "live", newDigest],
  ]);
  expect(compile(nodeId)).toMatchObject({ generation: 2n, image: { reference: "ghcr.io/seylo-dev/seylo:0.2.0-rc.2", digest: newDigest } });
});
