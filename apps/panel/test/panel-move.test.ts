// Moving the panel to another node (0.2.8), on the old panel's side with a
// fake fleet (move-fleet.ts): who may move it and what refuses it, the
// write pause while it moves, the copy it ships (consistent databases, the
// offline edit, the archive and its manifest), the switch, and undoing a
// move that failed or was cancelled at each step. The switch is
// CommitMovedPanel on the target: a definite refusal undoes the move, an
// answer that never comes is asked again until the owner cancels with
// force. The moved panel's side (standby until the commit marker, then the
// arrival), the offline alerts' grace, deleting the old copy, a restart of
// the old panel in the middle and the agents' protocol during a move
// (joins, reports, 503 at the switch) are at the end.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { defineOp, panelMove, permission, settings } from "@seylo/ops";
import { EventSchema, PanelService, ReportEventRequestSchema, ReportEventResponseSchema, StatusCode } from "@seylo/proto";
import { Type } from "@sinclair/typebox";
import { and, desc, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { agentStatusError, nodeOffline } from "../src/agent-hub/calls";
import { recordDialedUrl } from "../src/agent-hub/dialed";
import { openDatabases } from "../src/db/client";
import {
  auditLog,
  deployments,
  jobs,
  nodes,
  servicePlacements,
  services,
  sessions,
  settings as settingsTable,
  updateRuns,
} from "../src/db/schema";
import { panelWebsocket } from "../src/http/ws-guard";
import { nodeOfflineJob, nodeOfflineJobType } from "../src/modules/alerts/events";
import { modules } from "../src/modules/index.gen";
import { defineModule } from "../src/modules/module";
import { ensurePanelService, panelServiceId } from "../src/modules/nodes/panel-service";
import { checkMoveCommit, commitArrival } from "../src/modules/panelMove/arrival";
import { runCleanups } from "../src/modules/panelMove/cleanup";
import type { PanelMoveArrival, PanelMoveDone, PanelMoveOut } from "../src/modules/panelMove/keys";
import { moveTiming } from "../src/modules/panelMove/orchestrator";
import { setWritePause, writePause, writesInFlight } from "../src/modules/panelMove/pause";
import { recoverMoveOut } from "../src/modules/panelMove/recover";
import { dataFiles, editSnapshot, tarHeader, writeArchive } from "../src/modules/panelMove/snapshot";
import { activeMove, forceCancelAfterMs } from "../src/modules/panelMove/state";
import { moveStatus } from "../src/modules/panelMove/status";
import { implement } from "../src/ops/implement";
import { agentTlsPinOf, newAgentTlsKey } from "../src/security/agent-tls";
import { getSetting, setSetting } from "../src/settings";
import { agentKey, FakeAgent } from "./fake-agent";
import { callOp, createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { addJoinToken } from "./hub-helpers";
import { agentRefusal, held, MoveFleet, untar } from "./move-fleet";
import { fakeAgent } from "./seed-helpers";

let panel: TestPanel;
let fleet: MoveFleet;
let dataDir: string;
let owner: Awaited<ReturnType<typeof createUser>>;
let fromId: string;
let targetId: string;
let otherId: string;
const pinValue = () => agentTlsPinOf(join(dataDir, "agent-tls.key")) as string;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function addNode(name: string, values: Partial<typeof nodes.$inferInsert> = {}): string {
  return panel.deps.db
    .insert(nodes)
    .values({ name, publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))), ...values })
    .returning()
    .get().id;
}

/** The panel's data folder as an install has it, with files a move must never ship. */
function seedDataDir(dir: string) {
  writeFileSync(join(dir, "master.key"), `${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}\n`);
  writeFileSync(join(dir, "agent-tls.key"), newAgentTlsKey().keyPem);
  writeFileSync(join(dir, "agent-tls.crt"), "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
  mkdirSync(join(dir, "branding"));
  writeFileSync(join(dir, "branding", "favicon"), "icon-bytes");
  mkdirSync(join(dir, "uploads"));
  writeFileSync(join(dir, "uploads", "u1.tar.gz"), crypto.getRandomValues(new Uint8Array(70_000)));
  // move-commit: the commit marker of an earlier arrival here; a copy holding it could take agents before its own switch.
  for (const name of [
    "setup-token",
    "join-token",
    "telemetry-off",
    "ip-access-on",
    "panel.db-wal",
    "panel.db-shm",
    "metrics.db-wal",
    "move-commit",
  ]) {
    writeFileSync(join(dir, name), "never shipped");
  }
}

/** Polls the status in the process (the op has a rate limit); the op itself is checked where it matters. */
async function waitForState(state: string, timeoutMs = 5000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const status = moveStatus(panel.deps, true);
    if (status.state === state) return status;
    if (Date.now() > until) throw new Error(`the move did not reach ${state}: ${JSON.stringify(status)}`);
    await Bun.sleep(10);
  }
}

const start = (input: Partial<{ targetNodeId: string; address: string; leftBehind: boolean }> = {}, cookie = owner.cookie) =>
  callOp(panel, panelMove.start, { targetNodeId: targetId, ...input }, { cookie });

const check = (targetNodeId: string | undefined = targetId, options: { cookie?: string; bearer?: string } = { cookie: owner.cookie }) =>
  callOp(panel, panelMove.check, targetNodeId ? { targetNodeId } : {}, options);

const codes = (blocks: { code: string }[]) => blocks.map((block) => block.code);

/** The old panel with its three nodes, online, and its owner; again with other modules for a test that needs them. */
async function build(options: Parameters<typeof testPanel>[0] = {}) {
  panel = testPanel(options);
  dataDir = mkdtempSync(join(tmpdir(), "panel-move-"));
  seedDataDir(dataDir);
  panel.deps.config.dataDir = dataDir;
  panel.deps.config.image = `ghcr.io/seylo-dev/seylo:0.2.8@sha256:${"d".repeat(64)}`;
  panel.deps.config.hostPort = 3000;
  panel.deps.agentTls = { port: 3443, pin: pinValue() };
  setSetting(panel.deps.db, "panelAgentTlsPort", 3443);
  fromId = addNode("old", { publicIpv4: "203.0.113.10", isPanelNode: true });
  ensurePanelService(panel.deps);
  targetId = addNode("new", { publicIpv4: "203.0.113.20" });
  otherId = addNode("b", { publicIpv4: "203.0.113.30" });
  fleet = new MoveFleet(panel);
  for (const id of [fromId, targetId, otherId]) fleet.online.add(id);
  // The moved panel answers /api/health with this panel's version.
  fleet.answers.set("startMovedPanel", () => ({ version: panel.deps.config.version }));
  owner = await createUser(panel, "owner");
}

/** Closes what build made. */
async function tearDown() {
  // A move still running is cancelled and waited for, so nothing touches the database after it closed.
  const move = activeMove(panel.deps.db);
  if (move && !move.doneAt && !move.switching) move.abort.abort(new Error("test over"));
  for (let i = 0; i < 200 && activeMove(panel.deps.db) && !activeMove(panel.deps.db)?.doneAt; i++) await Bun.sleep(5);
  panel.close();
  rmSync(dataDir, { recursive: true, force: true });
}

const timing = { ...moveTiming };

beforeEach(() => build());

afterEach(async () => {
  await tearDown();
  Object.assign(moveTiming, timing);
});

describe("who may move the panel and what refuses it", () => {
  test("the owner sees every node with its reasons and the nodes that follow", async () => {
    const res = await check();
    expect(res.status).toBe(200);
    expect(res.body.blocks).toEqual([]);
    expect(res.body.defaultAddress).toBe("203.0.113.20");
    expect(res.body.fromNode).toEqual({ id: fromId, name: "old" });
    expect(res.body.agentPort).toBe(3443);
    expect(res.body.nodesToMove.map((n: { name: string }) => n.name)).toEqual(["b", "new", "old"]);
    expect(res.body.nodesLeftBehind).toEqual([]);
    const byName = Object.fromEntries(res.body.targets.map((t: { name: string }) => [t.name, t]));
    expect(byName.new).toMatchObject({ ready: true, online: true, address: "203.0.113.20", blocks: [] });
    expect(codes(byName.old.blocks)).toEqual(["targetIsPanel"]);
    expect(res.body.warnings).toEqual([
      expect.objectContaining({ code: "ipUrl", message: expect.stringContaining("http://203.0.113.20:3000") }),
    ]);

    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    const withDomain = await check();
    expect(withDomain.body.warnings).toEqual([
      expect.objectContaining({
        code: "domainDns",
        message: expect.stringContaining("Point the DNS record of panel.example.com at 203.0.113.20"),
      }),
    ]);
  });

  test("admins, API keys and MCP never move the panel", async () => {
    const admin = await createUser(panel, "admin");
    expect(codes((await check(targetId, { cookie: admin.cookie })).body.blocks)).toContain("notOwner");
    const key = createApiKey(panel, owner.user.id);
    expect(codes((await check(targetId, { bearer: key })).body.blocks)).toContain("notBrowser");
    const refused = await callOp(panel, panelMove.start, { targetNodeId: targetId }, { bearer: key });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("notBrowser");
    expect((await start({}, admin.cookie)).body.error.details.reason).toBe("notOwner");
    expect(activeMove(panel.deps.db)).toBeNull();
  });

  test("the target must be online, enabled, not the panel's node and run the panel's agent", async () => {
    expect(codes((await check(fromId)).body.blocks)).toEqual(["targetIsPanel"]);
    fleet.online.delete(targetId);
    expect(codes((await check()).body.blocks)).toEqual(["targetOffline"]);
    fleet.online.add(targetId);
    fleet.caps.set(targetId, new Set(["state.sync.v1"]));
    expect(codes((await check()).body.blocks)).toEqual(["targetTooOld"]);
    fleet.caps.delete(targetId);
    panel.deps.config.version = "0.2.8";
    panel.deps.db.update(nodes).set({ agentVersion: "0.2.7" }).where(eq(nodes.id, targetId)).run();
    const old = (await check()).body.blocks;
    expect(codes(old)).toEqual(["targetTooOld"]);
    expect(old[0].message).toContain("runs agent 0.2.7, the panel 0.2.8");
    panel.deps.db.update(nodes).set({ agentVersion: "0.2.8" }).where(eq(nodes.id, targetId)).run();
    expect((await check()).body.blocks).toEqual([]);
    panel.deps.db.update(nodes).set({ disabledAt: new Date() }).where(eq(nodes.id, targetId)).run();
    expect(codes((await check()).body.blocks)).toEqual(["targetDisabled"]);
    expect((await check("0000000000000000")).status).toBe(404);
  });

  test("panel-wide refusals: updates, work in flight, closed ports, Serve, a half rotation, no agents' port", async () => {
    const reason = async () => (await start()).body.error?.details?.reason;
    const run = panel.deps.db.insert(updateRuns).values({ targetVersion: "0.2.9", trigger: "manual" }).returning().get();
    expect(await reason()).toBe("updateRunning");
    panel.deps.db.update(updateRuns).set({ status: "succeeded" }).where(eq(updateRuns.id, run.id)).run();

    const live = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, panelServiceId)).get();
    const queued = panel.deps.db
      .insert(deployments)
      .values({ serviceId: panelServiceId, generation: 9, trigger: "manual", status: "queued" })
      .returning()
      .get();
    const blocked = (await check()).body.blocks;
    expect(codes(blocked)).toEqual(["workRunning"]);
    expect(blocked[0].message).toBe("1 deployment is queued or running. Try again once it finished.");
    panel.deps.db.delete(deployments).where(eq(deployments.id, queued.id)).run();
    expect(live).toBeDefined();
    panel.deps.db.insert(jobs).values({ type: "backups.restore", payload: {}, runAt: new Date() }).run();
    expect(await reason()).toBe("workRunning");
    panel.deps.db.delete(jobs).run();

    setSetting(panel.deps.db, "panelIpAccessApplied", { closed: true, agentPortClosed: false, at: Date.now(), reason: "x" });
    expect(await reason()).toBe("ipAccessClosed");
    setSetting(panel.deps.db, "panelIpAccessApplied", { closed: false, agentPortClosed: false, at: Date.now(), reason: "x" });

    setSetting(panel.deps.db, "tailscaleServe", true);
    expect(await reason()).toBe("tailscaleServe");
    setSetting(panel.deps.db, "tailscaleServe", false);

    writeFileSync(join(dataDir, "master.key.new"), "half");
    expect(await reason()).toBe("rotationUnfinished");
    rmSync(join(dataDir, "master.key.new"));

    panel.deps.agentTls = null;
    expect(await reason()).toBe("noAgentPort");
    panel.deps.agentTls = { port: 3443, pin: pinValue() };

    fleet.online.delete(fromId);
    expect(await reason()).toBe("panelNodeOffline");
    fleet.online.add(fromId);
    fleet.caps.set(fromId, new Set(["state.sync.v1"]));
    expect(await reason()).toBe("panelNodeTooOld");
    fleet.caps.delete(fromId);

    panel.deps.db.delete(servicePlacements).where(eq(servicePlacements.serviceId, panelServiceId)).run();
    expect(await reason()).toBe("panelNotManaged");
    expect(activeMove(panel.deps.db)).toBeNull();
  });

  test("nodes that cannot follow are a soft block: the owner ticks that they join them again", async () => {
    fleet.online.delete(otherId);
    const offline = (await check()).body;
    expect(offline.nodesLeftBehind).toEqual([{ id: otherId, name: "b", reason: "offline" }]);
    expect(offline.blocks).toEqual([expect.objectContaining({ code: "nodesLeftBehind", soft: true, nodeIds: [otherId] })]);
    expect(offline.blocks[0].message).toContain("seylo join --force");

    fleet.online.add(otherId);
    recordDialedUrl(panel.deps.db, otherId, "http://203.0.113.10:3000");
    expect((await check()).body.nodesLeftBehind).toEqual([{ id: otherId, name: "b", reason: "plainHttp" }]);
    expect((await start()).body.error.details).toMatchObject({ reason: "nodesLeftBehind", nodeIds: otherId });

    const started = await start({ leftBehind: true });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ state: "running", targetNodeName: "new", leftBehind: [{ id: otherId, name: "b" }] });
    const done = await waitForState("done");
    expect(done.leftBehind).toEqual([{ id: otherId, name: "b" }]);
    // Nobody told b the new address.
    expect(fleet.of("stagePanelAddress").map((c) => c.nodeId)).not.toContain(otherId);
  });

  test("starting needs a fresh sign-in and a usable address", async () => {
    panel.deps.db
      .update(sessions)
      .set({ createdAt: new Date(Date.now() - 20 * 60_000), reauthAt: null })
      .run();
    const stale = await start();
    expect(stale.status).toBe(403);
    expect(stale.body.error.details.reason).toBe("reauth");
    expect(activeMove(panel.deps.db)).toBeNull();
    owner = await createUser(panel, "owner");

    for (const address of ["http://203.0.113.20", "203.0.113.20:3443", "127.0.0.1", "localhost", "a b"]) {
      const res = await start({ address });
      expect(res.status).toBe(400);
      expect(res.body.error.details.field).toBe("address");
    }
    panel.deps.db.update(nodes).set({ publicIpv4: null }).where(eq(nodes.id, targetId)).run();
    expect((await start()).body.error.message).toContain("The panel knows no address of new");
    // Nodes on one private network: the private IPv4 the target's agent reports is the default.
    panel.deps.db
      .update(nodes)
      .set({ facts: { privateIpv4: "10.0.0.20" } })
      .where(eq(nodes.id, targetId))
      .run();
    const lan = await check();
    expect(lan.body.defaultAddress).toBe("10.0.0.20");
    expect(lan.body.targets.find((t: { id: string }) => t.id === targetId)?.address).toBe("10.0.0.20");
    panel.deps.db.update(nodes).set({ facts: {} }).where(eq(nodes.id, targetId)).run();

    const v6 = await start({ address: "[2001:DB8::20]" });
    expect(v6.status).toBe(200);
    expect(v6.body.targetAddress).toBe("2001:db8::20");
    await waitForState("done");
    const staged = fleet.of("stagePanelAddress").find((c) => c.nodeId === otherId);
    expect(staged?.request.panelUrl).toBe("https://[2001:db8::20]:3443");
  });

  test("a target or panel node on plain http:// from another server is refused before anything is shipped", async () => {
    // The archive with master.key would cross that connection in the clear, and the agent refuses the address over it.
    recordDialedUrl(panel.deps.db, targetId, "http://203.0.113.10:3000");
    const blocked = (await check()).body;
    expect(codes(blocked.blocks)).toEqual(["targetPlainHttp"]);
    expect(blocked.blocks[0].message).toContain("join --force");
    expect(blocked.targets.find((t: { id: string }) => t.id === targetId)).toMatchObject({ ready: false });
    expect((await start({ leftBehind: true })).body.error.details).toMatchObject({ reason: "targetPlainHttp", nodeIds: targetId });
    recordDialedUrl(panel.deps.db, targetId, "https://203.0.113.10:3443");
    expect((await check()).body.blocks).toEqual([]);

    // The panel's own node on loopback is how the installer sets it up; over http:// from another address it is not.
    recordDialedUrl(panel.deps.db, fromId, "http://127.0.0.1:3000");
    expect((await check()).body.blocks).toEqual([]);
    recordDialedUrl(panel.deps.db, fromId, "http://203.0.113.10:3000");
    expect(codes((await check()).body.blocks)).toEqual(["panelNodePlainHttp"]);
    expect((await start({ leftBehind: true })).body.error.details.reason).toBe("panelNodePlainHttp");
    expect(fleet.calls).toEqual([]);
    expect(activeMove(panel.deps.db)).toBeNull();
  });

  test("never an address of the server the panel leaves: the old panel answers there with the same key", async () => {
    panel.deps.db
      .update(nodes)
      .set({ publicAddress: "old.example.com", publicIpv6: "2001:db8::10", facts: { privateIpv4: "10.0.0.10" } })
      .where(eq(nodes.id, fromId))
      .run();
    for (const address of ["203.0.113.10", "OLD.example.com", "[2001:DB8:0::10]", "10.0.0.10"]) {
      const res = await start({ address });
      expect(res.status).toBe(400);
      expect(res.body.error.details.field).toBe("address");
      expect(res.body.error.message).toContain("is an address of old");
    }
    // The target's own default too, when both sit behind one address.
    panel.deps.db.update(nodes).set({ publicIpv4: "203.0.113.10" }).where(eq(nodes.id, targetId)).run();
    expect((await start()).body.error.details.field).toBe("address");
    expect(activeMove(panel.deps.db)).toBeNull();
    expect(fleet.calls).toEqual([]);
  });

  test("the warnings name the address the owner typed, when start would take it", async () => {
    const warn = async (address?: string) =>
      (
        await callOp(
          panel,
          panelMove.check,
          { targetNodeId: targetId, ...(address === undefined ? {} : { address }) },
          { cookie: owner.cookie },
        )
      ).body.warnings[0].message as string;
    expect(await warn("Panel2.example.net")).toContain("http://panel2.example.net:3000");
    expect(await warn("2001:db8::20")).toContain("http://[2001:db8::20]:3000");
    // Not an address start takes: the default it would use.
    for (const address of [undefined, "", "http://x", "203.0.113.10"]) expect(await warn(address)).toContain("http://203.0.113.20:3000");
    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    expect(await warn("panel2.example.net")).toContain("Point the DNS record of panel.example.com at panel2.example.net");
  });

  test("disabled nodes are part of the fleet: left behind with the others, or staged when their agent is connected", async () => {
    const disabledId = addNode("d", { publicIpv4: "203.0.113.40", disabledAt: new Date() });
    const offline = (await check()).body;
    expect(offline.nodesLeftBehind).toEqual([{ id: disabledId, name: "d", reason: "offline" }]);
    expect(offline.blocks).toEqual([expect.objectContaining({ code: "nodesLeftBehind", soft: true, nodeIds: [disabledId] })]);
    expect(offline.blocks[0].message).toContain("d is disabled, so it cannot follow");
    expect(offline.targets.map((t: { id: string }) => t.id)).not.toContain(disabledId);
    fleet.online.add(disabledId);
    expect((await check()).body.nodesToMove.map((n: { id: string }) => n.id)).toContain(disabledId);
    fleet.online.delete(disabledId);

    await start({ leftBehind: true });
    const done = await waitForState("done");
    expect(done.leftBehind).toEqual([{ id: disabledId, name: "d" }]);
  });

  test("the last move's old copy must be deleted first, unless its node is gone or the move goes back onto it", async () => {
    const done: PanelMoveDone = {
      moveId: "p".repeat(16),
      fromNodeId: otherId,
      fromNodeName: "b",
      toNodeId: fromId,
      toNodeName: "old",
      address: "203.0.113.10",
      at: Date.now() - 1000,
      leftBehind: [],
      domain: null,
      startedAt: Date.now() - 60_000,
    };
    setSetting(panel.deps.db, "panelMoveDone", done);
    const blocked = (await check()).body;
    expect(codes(blocked.blocks)).toEqual(["oldCopyLeft"]);
    expect(blocked.blocks[0]).toMatchObject({ soft: false, nodeIds: [otherId], message: expect.stringContaining("on b") });
    expect((await start({ leftBehind: true })).body.error.details.reason).toBe("oldCopyLeft");
    // Back onto b: the move sets that copy aside and its arrival deletes it.
    expect((await check(otherId)).body.blocks).toEqual([]);
    setSetting(panel.deps.db, "panelMoveDone", { ...done, oldCopyRemoved: true });
    expect((await check()).body.blocks).toEqual([]);
    setSetting(panel.deps.db, "panelMoveDone", { ...done, fromNodeId: "0".repeat(16) });
    expect((await check()).body.blocks).toEqual([]);
    expect(fleet.calls).toEqual([]);
  });
});

describe("the move", () => {
  test("copies, ships, starts, stages every node and switches; the old panel is retired", async () => {
    setSetting(panel.deps.db, "panelDomainStatus", {
      domain: "x",
      state: "active",
      message: "",
      checkedAt: Date.now(),
      working: true,
      since: Date.now(),
    } as never);
    recordDialedUrl(panel.deps.db, fromId, "http://127.0.0.1:3000");
    recordDialedUrl(panel.deps.db, targetId, "https://203.0.113.10:3443");
    recordDialedUrl(panel.deps.db, otherId, "https://203.0.113.10:3443");
    setSetting(panel.deps.db, "tailscaleSeen", { detected: true, state: "Running" } as never);
    // Undo work of an earlier failed move: once this panel is retired only the moved one can finish it.
    const cleanups = [{ moveId: "e".repeat(16), abortNodeId: otherId, clearNodeIds: [fromId], at: Date.now() }];
    setSetting(panel.deps.db, "panelMoveCleanups", cleanups);
    const before = panel.deps.db.select().from(services).where(eq(services.id, panelServiceId)).get();
    // At the commit every node is staged, this panel still takes agents, and a restart would send it again.
    let atCommit: unknown;
    fleet.answers.set("commitMovedPanel", () => {
      atCommit = { pause: writePause(panel.deps.db), out: getSetting(panel.deps.db, "panelMoveOut") };
      return {};
    });

    const started = await start();
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      state: "running",
      step: "pausing",
      targetNodeId: targetId,
      targetAddress: "203.0.113.20",
      canCancel: true,
    });
    const done = await waitForState("done");
    expect(done).toMatchObject({
      side: "old",
      step: "switching",
      fromNodeId: fromId,
      newUrl: "http://203.0.113.20:3000",
      leftBehind: [],
      oldPanelRunning: false,
      canCancel: false,
    });

    // The order of the agent calls, and where each went.
    expect(fleet.calls.map((c) => `${c.method}@${c.nodeId === fromId ? "old" : c.nodeId === targetId ? "new" : "b"}`)).toEqual([
      "exportRegistry@old",
      "importRegistry@new",
      "importPanelData@new",
      "startMovedPanel@new",
      "stagePanelAddress@new",
      "stagePanelAddress@b",
      "stagePanelAddress@old",
      "commitMovedPanel@new",
      "retirePanel@old",
    ]);
    expect(fleet.uploads.get("importRegistry")).toEqual(fleet.registry);
    const moveId = done.moveId as string;
    expect(atCommit).toMatchObject({
      pause: { reason: "moving", agentsClosed: false },
      out: { moveId, phase: "committing", staged: expect.arrayContaining([fromId, targetId, otherId]) },
    });
    for (const call of fleet.calls.filter((c) => c.method !== "startMovedPanel")) expect(call.request.moveId).toBe(moveId);

    // Every node is told the new address with the pin; the target reaches it on loopback.
    const staged = Object.fromEntries(fleet.of("stagePanelAddress").map((c) => [c.nodeId, c.request]));
    expect(staged[targetId]).toMatchObject({ panelUrl: "https://127.0.0.1:3443", panelPin: pinValue(), probe: true });
    expect(staged[otherId]).toMatchObject({ panelUrl: "https://203.0.113.20:3443", panelPin: pinValue(), probe: true });
    expect(staged[fromId]).toMatchObject({ panelUrl: "https://203.0.113.20:3443", panelPin: pinValue(), probe: true });
    // Every session but the old panel node's own was closed; the old node's agent stops this panel.
    expect(fleet.reconnects.sort()).toEqual([otherId, targetId].sort());
    expect(fleet.of("retirePanel")[0]?.request).toEqual(expect.objectContaining({ serviceId: panelServiceId }));

    // StartMovedPanel: the spec of the edited copy (next generation), the pin, the ports, this version, 3 minutes.
    const startCall = fleet.of("startMovedPanel")[0]?.request;
    expect(startCall).toMatchObject({
      moveId,
      panelPin: pinValue(),
      agentTlsPort: 3443,
      hostPort: 3000,
      expectedVersion: panel.deps.config.version,
    });
    expect(Number(startCall.healthTimeout.seconds)).toBe(180);
    expect(startCall.spec.id).toBe(panelServiceId);
    expect(Number(startCall.spec.generation)).toBe((before?.generation ?? 0) + 1);
    expect(startCall.spec.ports.map((p: { containerPort: number }) => p.containerPort)).toEqual([3000, 3443]);

    // The archive: the manifest's files, checked, and nothing else.
    const data = fleet.of("importPanelData")[0]?.request;
    const archive = fleet.uploads.get("importPanelData") as Buffer;
    expect(Number(data.sizeBytes)).toBe(archive.length);
    const files = untar(archive);
    const manifest = data.manifest.map((entry: { path: string; size: bigint; sha256: string }) => ({ ...entry, size: Number(entry.size) }));
    expect(manifest.map((entry: { path: string }) => entry.path)).toEqual([
      "panel.db",
      "metrics.db",
      "master.key",
      "agent-tls.key",
      "agent-tls.crt",
      "branding/favicon",
      "uploads/u1.tar.gz",
    ]);
    expect([...files.keys()].sort()).toEqual(manifest.map((entry: { path: string }) => entry.path).sort());
    for (const entry of manifest) {
      const bytes = files.get(entry.path) as Buffer;
      expect(bytes.length).toBe(entry.size);
      expect(sha(bytes)).toBe(entry.sha256);
    }
    expect(files.get("master.key")?.toString()).toBe(await Bun.file(join(dataDir, "master.key")).text());

    // The shipped panel.db: the target is the panel node, everything about the old server reset.
    const copyPath = join(dataDir, "shipped.db");
    writeFileSync(copyPath, files.get("panel.db") as Buffer);
    const sqlite = new Database(copyPath);
    const flags = sqlite.query<{ id: string; p: number }, []>("SELECT id, is_panel_node AS p FROM nodes").all();
    expect(flags.filter((row) => row.p === 1).map((row) => row.id)).toEqual([targetId]);
    const placements = sqlite
      .query<{ node_id: string }, [string]>("SELECT node_id FROM service_placements WHERE service_id = ?")
      .all(panelServiceId);
    expect(placements).toEqual([{ node_id: targetId }]);
    const lives = sqlite
      .query<{ generation: number; target_node_ids: string; trigger: string }, [string]>(
        "SELECT generation, target_node_ids, trigger FROM deployments WHERE service_id = ? AND status = 'live'",
      )
      .all(panelServiceId);
    expect(lives).toEqual([{ generation: (before?.generation ?? 0) + 1, target_node_ids: JSON.stringify([targetId]), trigger: "move" }]);
    const setting = (key: string) => {
      const row = sqlite.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
      return row ? JSON.parse(row.value) : undefined;
    };
    expect(setting("panelIpAccessApplied")).toMatchObject({ closed: false, agentPortClosed: false, by: "system" });
    expect(setting("tailscaleSeen")).toMatchObject({ detected: false, working: false });
    expect(setting("panelDomainStatus")).toBeUndefined();
    expect(Object.keys(setting("nodeDialedUrls"))).toEqual([otherId]);
    expect(setting("panelMoveArrival")).toMatchObject({
      moveId,
      fromNodeId: fromId,
      toNodeId: targetId,
      address: "203.0.113.20",
      leftBehind: [],
    });
    expect(setting("panelMoveOut")).toBeUndefined();
    expect(setting("panelMoveCleanups")).toEqual(cleanups);
    expect(sqlite.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    sqlite.close();

    // This panel's own database is untouched apart from the move's journal.
    expect(panel.deps.db.select().from(nodes).where(eq(nodes.isPanelNode, true)).get()?.id).toBe(fromId);
    expect(getSetting(panel.deps.db, "panelMoveOut")).toMatchObject({ moveId, phase: "moved", targetNodeId: targetId });
    // No work folder is left with the copy and master.key.
    expect(readdirSync(dataDir).filter((name) => name.startsWith(".move-"))).toEqual([]);

    // Retired: no changes, no agents, no jobs.
    const refused = await callOp(panel, settings.updateGeneral, { name: "x" }, { cookie: owner.cookie });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("panelMoved");
    expect(refused.body.error.message).toContain("http://203.0.113.20:3000");
    expect(panel.runner.held).toBe(true);
    expect(writePause(panel.deps.db)).toMatchObject({ reason: "moved", agentsClosed: true });
    const audit = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "panelMove.start")).get();
    expect(audit).toMatchObject({ outcome: "ok", actorId: owner.user.id });
    expect(panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "panelMove.switched")).get()).toBeDefined();
  });

  test("while it moves the panel only reads: changes, uploads and reports wait; cancel still works", async () => {
    const gate = held({ version: panel.deps.config.version });
    fleet.answers.set("startMovedPanel", gate.answer);
    await start();
    await gate.started;
    expect(panel.runner.held).toBe(true);
    expect((await callOp(panel, settings.general, {}, { cookie: owner.cookie })).status).toBe(200);
    // The old panel never answers health as a moved copy: a probe of an address that reaches it fails.
    const healthy = (await (await panel.app.handle(new Request("http://panel.test/api/health"))).json()) as Record<string, unknown>;
    expect(healthy).toMatchObject({ status: "ok" });
    expect(healthy.moveId).toBeUndefined();
    const refused = await callOp(panel, settings.updateGeneral, { name: "x" }, { cookie: owner.cookie });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "CONFLICT", message: "The panel is moving to new. Try again in a few minutes." });
    expect(refused.body.error.details.reason).toBe("panelMoving");
    // A second move is refused the same way.
    expect((await start()).body.error.details.reason).toBe("panelMoving");
    // Module endpoints that write (webhooks, uploads) answer 503 with Retry-After.
    const upload = await panel.app.handle(new Request("http://panel.test/api/uploads/services/x", { method: "POST", body: "x" }));
    expect(upload.status).toBe(503);
    expect(upload.headers.get("retry-after")).toBe("60");
    expect(((await upload.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe("panelMoving");
    // Durable reports stay in the agent's outbox.
    const report = toBinary(
      ReportEventRequestSchema,
      create(ReportEventRequestSchema, { outboxId: 1n, event: create(EventSchema, { payload: { case: "nodeAlert", value: {} } }) }),
    );
    const handlers = panel.deps.agents.panelService;
    await expect(
      handlers?.call(otherId, `/${PanelService.typeName}/ReportEvent`, report, new AbortController().signal),
    ).rejects.toMatchObject({
      code: StatusCode.UNAVAILABLE,
    });

    const cancelled = await callOp(panel, panelMove.cancel, {}, { cookie: owner.cookie });
    expect(cancelled.status).toBe(200);
    const failed = await waitForState("failed");
    expect(failed.error).toEqual({ step: "starting", message: `Cancelled by ${owner.user.email}.` });
    expect(fleet.of("abortMovedPanel").map((c) => c.nodeId)).toEqual([targetId]);
    // Writes and jobs are back.
    expect(panel.runner.held).toBe(false);
    expect((await callOp(panel, settings.updateGeneral, { name: "back" }, { cookie: owner.cookie })).status).toBe(200);
    await expect(
      handlers?.call(otherId, `/${PanelService.typeName}/ReportEvent`, report, new AbortController().signal),
    ).resolves.toBeDefined();
    expect((await callOp(panel, panelMove.cancel, {}, { cookie: owner.cookie })).body.error.details.reason).toBe("notRunning");
  });

  test.each([
    ["registry", "exportRegistry", "The registry storage could not be read."],
    ["shipping", "importPanelData", "panel.db does not match the manifest."],
    ["starting", "startMovedPanel", "The moved panel did not become healthy within 3m0s."],
  ])("a failure at %s undoes the move on the target and the panel takes changes again", async (step, method, message) => {
    fleet.answers.set(method, () => {
      throw agentRefusal("CONFLICT", message);
    });
    await start();
    const failed = await waitForState("failed");
    expect(failed.error).toEqual({ step, message });
    expect(fleet.of("abortMovedPanel")).toEqual([
      { nodeId: targetId, method: "abortMovedPanel", request: expect.objectContaining({ moveId: failed.moveId }) },
    ]);
    expect(fleet.of("clearPanelAddress")).toEqual([]);
    expect(fleet.of("retirePanel")).toEqual([]);
    expect(fleet.reconnects).toEqual([]);
    expect(panel.runner.held).toBe(false);
    expect(writePause(panel.deps.db)).toBeNull();
    expect(getSetting(panel.deps.db, "panelMoveOut")).toBeUndefined();
    expect(getSetting(panel.deps.db, "panelMoveFailure")).toMatchObject({ step, message });
    expect(readdirSync(dataDir).filter((name) => name.startsWith(".move-"))).toEqual([]);
    const audit = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "panelMove.failed")).get();
    expect(audit).toMatchObject({ outcome: "error", input: expect.objectContaining({ step, reason: message }) });
    expect((await callOp(panel, settings.updateGeneral, { name: "back" }, { cookie: owner.cookie })).status).toBe(200);
  });

  test("the target's desired state is held while the moved panel starts there; an abort releases it", async () => {
    // A send from the old panel (where the target is not the panel node) would drop the panel spec StartMovedPanel installed.
    const gate = held({ version: panel.deps.config.version });
    fleet.answers.set("startMovedPanel", gate.answer);
    fleet.answers.set("stagePanelAddress", (nodeId) => {
      if (nodeId === otherId) throw agentRefusal("UNAVAILABLE", "dial tcp 203.0.113.20:3443: i/o timeout");
      return {};
    });
    await start();
    await gate.started;
    // The flusher's side of the hold is in fix-flusher.test.ts.
    expect(panel.deps.agents.desired.isHeld(targetId)).toBe(true);
    expect(panel.deps.agents.desired.isHeld(otherId)).toBe(false);
    gate.release();
    // Staging fails on b: the move undoes itself and releases the target.
    await waitForState("failed");
    expect(panel.deps.agents.desired.isHeld(targetId)).toBe(false);
  });

  test("byte counts that disagree fail the move", async () => {
    fleet.answers.set("importPanelData", (_node, request, { bytes }) => ({
      sizeBytes: BigInt((bytes?.length ?? 0) - 1),
      files: request.manifest.length,
    }));
    await start();
    expect((await waitForState("failed")).error.message).toMatch(/^new received \d+ bytes of the panel's data, the panel sent \d+\.$/);
    fleet.calls.length = 0;
    fleet.answers.set("importPanelData", (_node, _request, { bytes }) => ({ sizeBytes: BigInt(bytes?.length ?? 0), files: 2 }));
    await start();
    expect((await waitForState("failed")).error.message).toBe("new unpacked 2 files of the panel's data, the panel sent 7.");
    fleet.answers.delete("importPanelData");
    fleet.answers.set("importRegistry", () => ({ sizeBytes: 5n }));
    await start();
    expect((await waitForState("failed")).error.message).toContain("of the image registry");
  });

  test("a node that cannot reach the new address ends the move by name; every staged node forgets it", async () => {
    fleet.answers.set("stagePanelAddress", (nodeId) => {
      if (nodeId === otherId) throw agentRefusal("UNAVAILABLE", "dial tcp 203.0.113.20:3443: i/o timeout");
      return {};
    });
    await start();
    const failed = await waitForState("failed");
    expect(failed.error.step).toBe("staging");
    expect(failed.error.message).toContain(
      "b could not reach the moved panel at https://203.0.113.20:3443: dial tcp 203.0.113.20:3443: i/o timeout.",
    );
    // The target stops first, then every node that may hold the address forgets it.
    const order = fleet.sequence();
    expect(order.indexOf("abortMovedPanel")).toBeLessThan(order.indexOf("clearPanelAddress"));
    expect(
      fleet
        .of("clearPanelAddress")
        .map((c) => c.nodeId)
        .sort(),
    ).toEqual([fromId, otherId, targetId].sort());
    expect(fleet.reconnects).toEqual([]);
    expect(writePause(panel.deps.db)).toBeNull();
  });

  test("calls that fail while undoing wait for the node to come back", async () => {
    fleet.answers.set("stagePanelAddress", (nodeId) => {
      if (nodeId === otherId) throw agentRefusal("UNAVAILABLE", "no route");
      return {};
    });
    fleet.answers.set("abortMovedPanel", () => {
      throw agentRefusal("UNAVAILABLE", "busy");
    });
    fleet.answers.set("clearPanelAddress", (nodeId) => {
      if (nodeId === fromId) throw agentRefusal("UNAVAILABLE", "busy");
      return {};
    });
    await start();
    const failed = await waitForState("failed");
    expect(getSetting(panel.deps.db, "panelMoveCleanups")).toEqual([
      { moveId: failed.moveId, abortNodeId: targetId, clearNodeIds: [fromId], at: expect.any(Number) },
    ]);
    fleet.answers.delete("abortMovedPanel");
    fleet.answers.delete("clearPanelAddress");
    await runCleanups(panel.deps, targetId);
    expect(getSetting(panel.deps.db, "panelMoveCleanups")).toEqual([
      { moveId: failed.moveId, abortNodeId: null, clearNodeIds: [fromId], at: expect.any(Number) },
    ]);
    await runCleanups(panel.deps, fromId);
    expect(getSetting(panel.deps.db, "panelMoveCleanups")).toBeUndefined();
  });

  test("the switch cannot be cancelled; an old node that does not take RetirePanel is sent to the new address too", async () => {
    let calls = 0;
    const gate = held({});
    fleet.answers.set("retirePanel", async (...args) => {
      calls++;
      if (calls === 1) return gate.answer(...args);
      throw agentRefusal("UNAVAILABLE", "busy");
    });
    await start();
    await gate.started;
    const refused = await callOp(panel, panelMove.cancel, {}, { cookie: owner.cookie });
    expect(refused.body.error.details.reason).toBe("switching");
    // Agents' connects answer 503 from the switch on.
    expect(writePause(panel.deps.db)).toMatchObject({ reason: "moving", agentsClosed: true });
    gate.release();
    const done = await waitForState("done");
    expect(done.oldPanelRunning).toBe(false);
  });

  test("an old node that never confirms RetirePanel is sent to the new address too", async () => {
    fleet.answers.set("retirePanel", () => {
      throw agentRefusal("UNAVAILABLE", "busy");
    });
    await start();
    const done = await waitForState("done", 15_000);
    expect(done.oldPanelRunning).toBe(true);
    expect(fleet.of("retirePanel")).toHaveLength(3);
    expect(fleet.reconnects).toContain(fromId);
    expect(getSetting(panel.deps.db, "panelMoveOut")).toMatchObject({ phase: "moved", oldPanelRunning: true });
  }, 20_000);

  test("nodes left behind that came back during the move are told the new address after all", async () => {
    fleet.online.delete(otherId);
    const gate = held({ version: panel.deps.config.version });
    fleet.answers.set("startMovedPanel", gate.answer);
    await start({ leftBehind: true });
    await gate.started;
    fleet.online.add(otherId);
    gate.release();
    const done = await waitForState("done");
    expect(done.leftBehind).toEqual([]);
    expect(fleet.of("stagePanelAddress").map((c) => c.nodeId)).toContain(otherId);
  });
});

describe("the switch: CommitMovedPanel on the target", () => {
  test("a target that refuses it for sure undoes the move; nothing was committed", async () => {
    fleet.answers.set("commitMovedPanel", (nodeId) => {
      throw agentStatusError(nodeId, {
        code: StatusCode.FAILED_PRECONDITION,
        message: "No healthy moved panel of this move runs here.",
        details: { reason: "notStarted" },
      });
    });
    await start();
    const failed = await waitForState("failed");
    expect(failed.error).toEqual({
      step: "switching",
      message: "new did not take the switch: No healthy moved panel of this move runs here.",
    });
    const order = fleet.sequence();
    expect(order.indexOf("commitMovedPanel")).toBeLessThan(order.indexOf("abortMovedPanel"));
    expect(fleet.of("commitMovedPanel")).toHaveLength(1);
    expect(fleet.of("retirePanel")).toEqual([]);
    expect(fleet.reconnects).toEqual([]);
    expect(
      fleet
        .of("clearPanelAddress")
        .map((c) => c.nodeId)
        .sort(),
    ).toEqual([fromId, otherId, targetId].sort());
    expect(panel.deps.agents.desired.isHeld(targetId)).toBe(false);
    expect(writePause(panel.deps.db)).toBeNull();
    expect(panel.runner.held).toBe(false);
  });

  test("an answer that never comes is no answer: asked again while the panel stays read-only and keeps every node", async () => {
    moveTiming.commitRetryMs = 20;
    let tries = 0;
    fleet.answers.set("commitMovedPanel", (nodeId) => {
      tries++;
      if (tries === 1) throw agentRefusal("UNAVAILABLE", "The node did not answer in time.");
      if (tries === 2) throw nodeOffline(nodeId);
      if (tries < 5) throw agentStatusError(nodeId, { code: StatusCode.INTERNAL, message: "", details: {} });
      return {};
    });
    let seen: any;
    fleet.answers.set("retirePanel", () => {
      seen = { ...moveStatus(panel.deps, true), pause: writePause(panel.deps.db) };
      return {};
    });
    await start();
    const done = await waitForState("done");
    expect(tries).toBe(5);
    expect(done.oldPanelRunning).toBe(false);
    expect(seen.pause).toMatchObject({ agentsClosed: true });
    // Nothing undid it on the way.
    expect(fleet.of("abortMovedPanel")).toEqual([]);
    expect(fleet.of("clearPanelAddress")).toEqual([]);
  });

  test("while it waits: no plain cancel, agents still taken, a cancel with force only after 10 minutes", async () => {
    moveTiming.commitRetryMs = 20;
    fleet.answers.set("commitMovedPanel", () => {
      throw agentRefusal("UNAVAILABLE", "The node did not answer in time.");
    });
    await start();
    for (let i = 0; i < 500 && !activeMove(panel.deps.db)?.waitingSince; i++) await Bun.sleep(5);
    const move = activeMove(panel.deps.db);
    expect(move?.waitingSince).toBeNumber();
    const waiting = (await callOp(panel, panelMove.status, {}, { cookie: owner.cookie })).body;
    expect(waiting).toMatchObject({ state: "running", step: "switching", canCancel: false, canForceCancel: false });
    expect(waiting.waitingSince).toBe(new Date(move?.waitingSince ?? 0).toISOString());
    expect(getSetting(panel.deps.db, "panelMoveOut")).toMatchObject({ phase: "committing", waitingSince: move?.waitingSince });
    // The old panel still serves every node and takes no change.
    expect(writePause(panel.deps.db)).toMatchObject({ reason: "moving", agentsClosed: false });
    expect((await callOp(panel, settings.updateGeneral, { name: "x" }, { cookie: owner.cookie })).body.error.details.reason).toBe(
      "panelMoving",
    );
    const plain = await callOp(panel, panelMove.cancel, {}, { cookie: owner.cookie });
    expect(plain.body.error.details.reason).toBe("switching");
    const early = await callOp(panel, panelMove.cancel, { force: true }, { cookie: owner.cookie });
    expect(early.body.error.details.reason).toBe("switching");
    expect(early.body.error.message).toContain("10 minutes");

    // Ten minutes without an answer.
    if (move) move.waitingSince = Date.now() - forceCancelAfterMs - 1000;
    expect((await callOp(panel, panelMove.status, {}, { cookie: owner.cookie })).body.canForceCancel).toBe(true);
    // The target is gone: its abort waits for it.
    fleet.online.delete(targetId);
    const forced = await callOp(panel, panelMove.cancel, { force: true }, { cookie: owner.cookie });
    expect(forced.status).toBe(200);
    const failed = await waitForState("failed");
    expect(failed.error).toMatchObject({ step: "switching", message: expect.stringContaining("Cancelled with force by") });
    expect(getSetting(panel.deps.db, "panelMoveCleanups")).toEqual([
      { moveId: failed.moveId, abortNodeId: targetId, clearNodeIds: [targetId], at: expect.any(Number) },
    ]);
    expect(panel.deps.agents.desired.isHeld(targetId)).toBe(false);
    expect(writePause(panel.deps.db)).toBeNull();
    expect(panel.runner.held).toBe(false);
    const audit = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "panelMove.cancel")).orderBy(desc(auditLog.id)).get();
    expect(audit).toMatchObject({ outcome: "ok", input: expect.objectContaining({ forced: true }) });
  });

  test("a forced cancel the target contradicts (it had committed) is reported and dropped", async () => {
    moveTiming.commitRetryMs = 20;
    let tries = 0;
    // The first commit landed, but its answer was lost; then the target went away.
    fleet.answers.set("commitMovedPanel", (nodeId, request) => {
      tries++;
      if (tries === 1) fleet.committed.add(`${nodeId}/${request.moveId}`);
      throw agentRefusal("UNAVAILABLE", "The node did not answer in time.");
    });
    await start();
    for (let i = 0; i < 500 && !activeMove(panel.deps.db)?.waitingSince; i++) await Bun.sleep(5);
    const move = activeMove(panel.deps.db);
    if (move) move.waitingSince = Date.now() - forceCancelAfterMs - 1000;
    fleet.online.delete(targetId);
    expect((await callOp(panel, panelMove.cancel, { force: true }, { cookie: owner.cookie })).status).toBe(200);
    const failed = await waitForState("failed");
    // Back: the queued abort is refused, since the switch landed there.
    fleet.online.add(targetId);
    await runCleanups(panel.deps, targetId);
    expect(getSetting(panel.deps.db, "panelMoveCleanups")).toBeUndefined();
    const conflict = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "panelMove.forcedCancelConflict")).get();
    expect(conflict).toMatchObject({ outcome: "error", input: expect.objectContaining({ moveId: failed.moveId, target: targetId }) });
    // Its staged address leads to its own moved panel: it is not cleared.
    expect(fleet.of("clearPanelAddress").filter((c) => c.nodeId === targetId)).toEqual([]);
  });

  test("a forced cancel the target contradicts at once is reported too, and its address is left alone", async () => {
    moveTiming.commitRetryMs = 20;
    let tries = 0;
    fleet.answers.set("commitMovedPanel", (nodeId, request) => {
      tries++;
      if (tries === 1) fleet.committed.add(`${nodeId}/${request.moveId}`);
      throw agentRefusal("UNAVAILABLE", "The node did not answer in time.");
    });
    await start();
    for (let i = 0; i < 500 && !activeMove(panel.deps.db)?.waitingSince; i++) await Bun.sleep(5);
    const move = activeMove(panel.deps.db);
    if (move) move.waitingSince = Date.now() - forceCancelAfterMs - 1000;
    expect((await callOp(panel, panelMove.cancel, { force: true }, { cookie: owner.cookie })).status).toBe(200);
    const failed = await waitForState("failed");
    expect(panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "panelMove.forcedCancelConflict")).get()).toMatchObject({
      input: expect.objectContaining({ moveId: failed.moveId, target: targetId, targetName: "new" }),
    });
    expect(getSetting(panel.deps.db, "panelMoveCleanups")).toBeUndefined();
    expect(
      fleet
        .of("clearPanelAddress")
        .map((c) => c.nodeId)
        .sort(),
    ).toEqual([fromId, otherId].sort());
  });
});

describe("changes in flight when the move starts", () => {
  /** A change that passed the gate and awaits something (an agent, a provider, a body) before it writes. */
  const slowWrite = defineOp({
    id: "moveTestSlow.write",
    kind: "mutation",
    summary: "Slow write",
    description: "A change that awaits before it writes, used only by the panel move tests.",
    input: Type.Object({}),
    output: Type.Object({ done: Type.Boolean() }),
    permission: permission.global("settings.manage"),
    mcp: false,
    audit: true,
  });
  const deferred = () => {
    let release!: () => void;
    let begin!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    return { release, wait, begin, started };
  };
  let opGate = deferred();
  let hookGate = deferred();
  const written = (db: TestPanel["deps"]["db"], key: string) => db.insert(settingsTable).values({ key, value: "written" }).run();
  const slow = defineModule({
    name: "moveTestSlow",
    ops: [
      implement(slowWrite, async (_input, ctx) => {
        opGate.begin();
        await opGate.wait;
        written(ctx.db, "moveTestOp");
        return { done: true };
      }),
    ],
    http: (deps) =>
      new Elysia({ name: "move-test-slow" }).post("/hooks/move-test", async () => {
        hookGate.begin();
        await hookGate.wait;
        written(deps.db, "moveTestHook");
        return "ok";
      }),
  });

  beforeEach(async () => {
    await tearDown();
    opGate = deferred();
    hookGate = deferred();
    await build({ modules: [...modules, slow] });
  });

  /** The settings rows of the panel.db the move shipped. */
  const shippedSetting = (key: string): unknown => {
    const files = untar(fleet.uploads.get("importPanelData") as Buffer);
    const copyPath = join(dataDir, "shipped.db");
    writeFileSync(copyPath, files.get("panel.db") as Buffer);
    const sqlite = new Database(copyPath);
    try {
      const row = sqlite.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
      return row ? JSON.parse(row.value) : undefined;
    } finally {
      sqlite.close();
    }
  };

  test("an op and a webhook that passed the gate finish before the copy, and their rows are in it", async () => {
    const key = createApiKey(panel, owner.user.id);
    const op = panel.execute({
      op: slowWrite,
      rawInput: {},
      credentials: { bearerToken: key },
      transport: "http",
      coerce: false,
      ip: null,
      userAgent: null,
      http: null,
    });
    const hook = panel.app.handle(new Request("http://panel.test/hooks/move-test", { method: "POST", body: "{}" }));
    await Promise.all([opGate.started, hookGate.started]);
    expect(writesInFlight(panel.deps.db)).toBe(2);

    expect((await start()).status).toBe(200);
    await Bun.sleep(50);
    // Still pausing: nothing left this panel yet.
    expect(moveStatus(panel.deps, true).step).toBe("pausing");
    expect(fleet.calls).toEqual([]);
    opGate.release();
    expect(await op).toEqual({ ok: true, output: { done: true } });
    await Bun.sleep(50);
    expect(fleet.calls).toEqual([]);
    hookGate.release();
    expect((await hook).status).toBe(200);

    await waitForState("done");
    expect(writesInFlight(panel.deps.db)).toBe(0);
    expect(shippedSetting("moveTestOp")).toBe("written");
    expect(shippedSetting("moveTestHook")).toBe("written");
  });

  test("a change that never finishes fails the move cleanly within the bound", async () => {
    moveTiming.writesTimeoutMs = 100;
    const hook = panel.app.handle(new Request("http://panel.test/hooks/move-test", { method: "POST", body: "{}" }));
    await hookGate.started;
    await start();
    const failed = await waitForState("failed");
    expect(failed.error).toMatchObject({ step: "pausing", message: expect.stringContaining("did not finish in time") });
    expect(fleet.calls).toEqual([]);
    expect(writePause(panel.deps.db)).toBeNull();
    expect(panel.runner.held).toBe(false);
    hookGate.release();
    expect((await hook).status).toBe(200);
    // Counted down once the response is out (Elysia's afterResponse, a moment after).
    for (let i = 0; i < 100 && writesInFlight(panel.deps.db) > 0; i++) await Bun.sleep(5);
    expect(writesInFlight(panel.deps.db)).toBe(0);
  });

  test("a webhook while the panel moves is refused and counts nothing", async () => {
    setWritePause(panel.deps.db, { reason: "moving", targetName: "new", agentsClosed: false });
    const refused = await panel.app.handle(new Request("http://panel.test/hooks/move-test", { method: "POST", body: "{}" }));
    expect(refused.status).toBe(503);
    expect(writesInFlight(panel.deps.db)).toBe(0);
    setWritePause(panel.deps.db, null);
  });
});

describe("the copy", () => {
  test("snapshotTo makes consistent copies while another process writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panel-move-snap-"));
    const panelPath = join(dir, "panel.db");
    const databases = openDatabases({ panelPath, metricsPath: join(dir, "metrics.db"), migrationsDir: panel.deps.config.migrationsDir });
    const raw = new Database(panelPath);
    raw.run("CREATE TABLE pair_a (n INTEGER)");
    raw.run("CREATE TABLE pair_b (n INTEGER)");
    raw.close();
    // Every transaction adds one row to each table: a torn copy would show different counts.
    const writer = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(panelPath)}); db.run("PRAGMA busy_timeout = 5000"); const add = db.transaction((i) => { db.run("INSERT INTO pair_a VALUES (?)", [i]); db.run("INSERT INTO pair_b VALUES (?)", [i]); }); const until = Date.now() + 1500; for (let i = 0; Date.now() < until; i++) add(i);`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const counts: number[] = [];
    try {
      for (let i = 0; i < 6; i++) {
        await Bun.sleep(150);
        const out = join(dir, `snap-${i}`);
        mkdirSync(out);
        const copies = databases.snapshotTo(out);
        const copy = new Database(copies.panel, { readonly: true });
        const a = copy.query<{ n: number }, []>("SELECT count(*) AS n FROM pair_a").get()?.n ?? -1;
        const b = copy.query<{ n: number }, []>("SELECT count(*) AS n FROM pair_b").get()?.n ?? -2;
        expect(copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        expect(copy.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
        copy.close();
        expect(a).toBe(b);
        counts.push(a);
        expect(existsSync(`${copies.panel}-wal`)).toBe(false);
        expect(existsSync(copies.metrics)).toBe(true);
      }
    } finally {
      await writer.exited;
      databases.close();
      rmSync(dir, { recursive: true, force: true });
    }
    // The writer really ran during the copies.
    expect(counts.at(-1)).toBeGreaterThan(counts[0] as number);
  });

  test("the offline edit refuses a copy without both nodes or a panel service", () => {
    const dir = mkdtempSync(join(tmpdir(), "panel-move-edit-"));
    try {
      const copies = (panel.deps.databases as NonNullable<typeof panel.deps.databases>).snapshotTo(dir);
      const edit = {
        moveId: "m".repeat(16),
        fromNodeId: fromId,
        fromNodeName: "old",
        toNodeId: "0".repeat(16),
        toNodeName: "gone",
        address: "203.0.113.20",
        leftBehind: [],
        domain: null,
        startedAt: Date.now(),
        now: Date.now(),
      };
      expect(() => editSnapshot(copies.panel, edit)).toThrow("missing one of the two nodes");
      const generation = editSnapshot(copies.panel, { ...edit, toNodeId: targetId });
      expect(generation).toBe(2);
      // Nothing of a half edit stays: the refused edit changed no row.
      const db = new Database(copies.panel);
      expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM deployments WHERE status = 'live'").get()?.n).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the archive keeps only the allowlist, skips links and fails a file that changes while it is read", async () => {
    const files = dataFiles(dataDir).map((file) => file.path);
    expect(files).toEqual(["master.key", "agent-tls.key", "agent-tls.crt", "branding/favicon", "uploads/u1.tar.gz"]);
    const dir = mkdtempSync(join(tmpdir(), "panel-move-tar-"));
    try {
      const deep = `uploads/${"d".repeat(90)}/${"f".repeat(60)}.tar.gz`;
      mkdirSync(join(dataDir, "uploads", "d".repeat(90)));
      writeFileSync(join(dataDir, deep), "deep");
      const archive = join(dir, "a.tar.gz");
      const manifest = await writeArchive([{ path: deep, from: join(dataDir, deep) }], archive);
      const unpacked = untar(Buffer.from(await Bun.file(archive).arrayBuffer()));
      expect([...unpacked.keys()]).toEqual([deep]);
      expect(manifest).toEqual([{ path: deep, size: 4, sha256: sha(Buffer.from("deep")) }]);
      // Sizes past 8 GiB use base-256, which Go's archive/tar reads.
      const big = tarHeader("big", 9 * 1024 ** 3, 0o600, 0, "0");
      expect(big[124]).toBe(0x80);
      // The system tar reads what the panel writes.
      const out = join(dir, "out");
      mkdirSync(out);
      const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", out]);
      expect(tar.exitCode).toBe(0);
      expect(await Bun.file(join(out, deep)).text()).toBe("deep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the moved panel", () => {
  const arrival = (): PanelMoveArrival => ({
    moveId: "m".repeat(16),
    fromNodeId: fromId,
    fromNodeName: "old",
    toNodeId: targetId,
    toNodeName: "new",
    address: "203.0.113.20",
    at: Date.now() - 1000,
    leftBehind: [otherId],
    domain: null,
    startedAt: Date.now() - 60_000,
  });

  /** A panel.db holding an arrival, as the old panel ships it; the nodes get fresh ids and the target the agent key. */
  function shippedCopy(dir: string, masterKey: Uint8Array, key = agentKey()) {
    const panelPath = join(dir, "panel.db");
    const first = testPanel({ panelPath, masterKey });
    const ids = ["old", "new", "b"].map(
      (name) =>
        first.deps.db
          .insert(nodes)
          .values({
            name,
            publicKey: name === "new" ? Buffer.from(key.publicKey) : Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
            isPanelNode: name === "new",
          })
          .returning()
          .get().id,
    );
    [fromId, targetId, otherId] = ids as [string, string, string];
    setSetting(first.deps.db, "panelMoveArrival", arrival());
    first.close();
    return { panelPath, key };
  }

  const health = async (app: { handle(request: Request): Promise<Response> | Response }) =>
    (await (await app.handle(new Request("http://panel.test/api/health"))).json()) as { status: string; moveId?: string };

  test("is a standby until the old panel commits the switch here: agents get 503, health names the move", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panel-move-arrive-"));
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const { panelPath, key } = shippedCopy(dir, masterKey);
    const moved = testPanel({ panelPath, masterKey, dataDir: dir });
    moved.app.listen({ hostname: "127.0.0.1", port: 0, websocket: panelWebsocket });
    const url = `http://127.0.0.1:${moved.app.server?.port}`;
    try {
      const me = await createUser(moved, "owner");
      expect(moved.runner.held).toBe(true);
      const refused = await callOp(moved, settings.updateGeneral, { name: "x" }, { cookie: me.cookie });
      expect(refused.body.error.details.reason).toBe("panelMoving");
      const waiting = (await callOp(moved, panelMove.status, {}, { cookie: me.cookie })).body;
      expect(waiting).toMatchObject({ state: "running", step: "switching", targetNodeName: "new", fromNodeName: "old", canCancel: false });
      // The probe of every node requires the move id, on the panel port and the agents' TLS port alike.
      expect(await health(moved.app)).toMatchObject({ status: "ok", moveId: "m".repeat(16) });
      expect(await health(moved.agentApp)).toMatchObject({ status: "ok", moveId: "m".repeat(16) });

      // A node that lost the old panel and dials here early gets 503 and goes back.
      const early = new FakeAgent({ url, panelId: moved.deps.panelId, nodeId: targetId, key });
      await expect(early.connect()).rejects.toBeDefined();
      expect(moved.deps.agents.isOnline(targetId)).toBe(false);
      // Even a session that got this far commits nothing before the switch.
      const stray = fakeAgent(moved, otherId);
      stray.disconnect();
      expect(getSetting(moved.deps.db, "panelMoveArrival")).toBeDefined();
      // A marker of another move opens nothing.
      writeFileSync(join(dir, "move-commit"), "z".repeat(16));
      expect(checkMoveCommit(moved.deps)).toBe(false);
      expect(writePause(moved.deps.db)?.agentsClosed).toBe(true);

      // CommitMovedPanel writes the marker with this move's id: within about a second agents are taken.
      writeFileSync(join(dir, "move-commit"), `${"m".repeat(16)}\n`);
      for (let i = 0; i < 300 && writePause(moved.deps.db)?.agentsClosed; i++) await Bun.sleep(10);
      expect(writePause(moved.deps.db)).toMatchObject({ reason: "moving", agentsClosed: false });
      // Still the copy until its first agent: changes wait, the probe still sees the move.
      expect((await callOp(moved, settings.updateGeneral, { name: "x" }, { cookie: me.cookie })).body.error.details.reason).toBe(
        "panelMoving",
      );
      expect((await health(moved.app)).moveId).toBe("m".repeat(16));

      const agent = new FakeAgent({ url, panelId: moved.deps.panelId, nodeId: targetId, key });
      await agent.connect();
      expect(agent.nodeId).toBe(targetId);
      expect(getSetting(moved.deps.db, "panelMoveArrival")).toBeUndefined();
      expect(existsSync(join(dir, "move-commit"))).toBe(false);
      expect((await health(moved.app)).moveId).toBeUndefined();
      expect(moved.runner.held).toBe(false);
      await agent.close();
    } finally {
      await moved.app.stop(true);
      moved.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a standby that restarts after the commit takes agents at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panel-move-arrive-"));
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const { panelPath } = shippedCopy(dir, masterKey);
    writeFileSync(join(dir, "move-commit"), "m".repeat(16));
    const moved = testPanel({ panelPath, masterKey, dataDir: dir });
    try {
      expect(writePause(moved.deps.db)).toMatchObject({ reason: "moving", agentsClosed: false, arrivalMoveId: "m".repeat(16) });
    } finally {
      moved.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("waits for its first agent with jobs held and changes refused, then takes over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panel-move-arrive-"));
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const { panelPath } = shippedCopy(dir, masterKey);
    writeFileSync(join(dir, "move-commit"), "m".repeat(16));

    const moved = testPanel({ panelPath, masterKey, dataDir: dir });
    try {
      const me = await createUser(moved, "owner");
      expect(moved.runner.held).toBe(true);
      const refused = await callOp(moved, settings.updateGeneral, { name: "x" }, { cookie: me.cookie });
      expect(refused.body.error.details.reason).toBe("panelMoving");
      const waiting = (await callOp(moved, panelMove.status, {}, { cookie: me.cookie })).body;
      expect(waiting).toMatchObject({ state: "running", step: "switching", targetNodeName: "new", fromNodeName: "old", canCancel: false });

      const agent = fakeAgent(moved, targetId);
      expect(getSetting(moved.deps.db, "panelMoveArrival")).toBeUndefined();
      const done = getSetting(moved.deps.db, "panelMoveDone") as PanelMoveDone;
      expect(done).toMatchObject({ moveId: "m".repeat(16), fromNodeId: fromId, toNodeId: targetId, leftBehind: [otherId] });
      expect(moved.runner.held).toBe(false);
      expect(writePause(moved.deps.db)).toBeNull();
      expect((await callOp(moved, settings.updateGeneral, { name: "moved" }, { cookie: me.cookie })).status).toBe(200);
      const audit = moved.deps.db.select().from(auditLog).where(eq(auditLog.opId, "panelMove.arrived")).get();
      expect(audit).toMatchObject({ actorType: "system", input: expect.objectContaining({ firstNodeId: targetId }) });
      // The nodes still away get the offline alert only after the grace.
      const pending = moved.deps.db.select().from(jobs).where(eq(jobs.type, nodeOfflineJobType)).all();
      expect(pending.map((job) => (job.payload as { nodeId: string }).nodeId).sort()).toEqual([fromId, otherId].sort());
      for (const job of pending) expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);

      const status = (await callOp(moved, panelMove.status, {}, { cookie: me.cookie })).body;
      expect(status).toMatchObject({ state: "done", side: "new", leftBehind: [{ id: otherId, name: "b" }], oldCopyRemoved: false });

      // The old node, once back, gets RetirePanel from here too.
      const old = fakeAgent(moved, fromId, { retirePanel: () => ({}) });
      for (let i = 0; i < 100 && !getSetting(moved.deps.db, "panelMoveDone")?.oldPanelRetired; i++) await Bun.sleep(5);
      expect(old.calls.map((c) => c.method)).toEqual(["retirePanel"]);
      expect(getSetting(moved.deps.db, "panelMoveDone")?.oldPanelRetired).toBe(true);
      agent.disconnect();
      old.disconnect();
      // A second connect commits nothing again.
      expect(commitArrival(moved.deps, targetId)).toBeNull();
    } finally {
      moved.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("node offline alerts wait out the grace after the move", async () => {
    const done: PanelMoveDone = { ...arrival(), at: Date.now() - 60_000 };
    setSetting(panel.deps.db, "panelMoveDone", done);
    const ctx = { ...panel.deps, jobId: "j", attempt: 1 };
    fleet.online.delete(otherId);
    await nodeOfflineJob.run({ nodeId: otherId, since: "1" }, ctx);
    expect(
      panel.deps.db
        .select()
        .from(jobs)
        .where(eq(jobs.dedupeKey, `node-offline-after-move:${otherId}`))
        .get()
        ?.runAt.getTime(),
    ).toBe(done.at + 5 * 60_000 + 1000);
    expect(panel.deps.alerts.isOpen(`node-offline:${otherId}:`)).toBe(false);
    setSetting(panel.deps.db, "panelMoveDone", { ...done, at: Date.now() - 6 * 60_000 });
    await nodeOfflineJob.run({ nodeId: otherId, since: "1" }, ctx);
    expect(panel.deps.alerts.isOpen(`node-offline:${otherId}:`)).toBe(true);
  });

  test("Delete the old copy: owner, fresh, the old node online, once", async () => {
    setSetting(panel.deps.db, "panelMoveDone", { ...arrival(), at: Date.now() });
    panel.deps.db.update(nodes).set({ isPanelNode: false }).run();
    panel.deps.db.update(nodes).set({ isPanelNode: true }).where(eq(nodes.id, targetId)).run();
    fleet.answers.set("removeOldPanel", () => ({ freedBytes: 123_456n }));
    const admin = await createUser(panel, "admin");
    expect((await callOp(panel, panelMove.removeOldCopy, {}, { cookie: admin.cookie })).body.error.details.reason).toBe("notOwner");
    fleet.online.delete(fromId);
    expect((await callOp(panel, panelMove.removeOldCopy, {}, { cookie: owner.cookie })).status).toBe(503);
    fleet.online.add(fromId);
    const removed = await callOp(panel, panelMove.removeOldCopy, {}, { cookie: owner.cookie });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ freedBytes: 123_456, status: { state: "done", side: "new", oldCopyRemoved: true } });
    expect(fleet.of("removeOldPanel")).toEqual([{ nodeId: fromId, method: "removeOldPanel", request: { serviceId: panelServiceId } }]);
    expect((await callOp(panel, panelMove.removeOldCopy, {}, { cookie: owner.cookie })).body.error.details.reason).toBe("removed");
    const row = panel.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.opId, "panelMove.removeOldCopy"), eq(auditLog.outcome, "ok")))
      .orderBy(desc(auditLog.id))
      .get();
    expect(row?.input).toMatchObject({ freedBytes: 123_456 });
  });

  test("a later move that failed never hides an old copy still on its server", async () => {
    const done: PanelMoveDone = { ...arrival(), at: Date.now() - 60_000 };
    setSetting(panel.deps.db, "panelMoveDone", done);
    setSetting(panel.deps.db, "panelMoveFailure", {
      moveId: "f".repeat(16),
      targetNodeId: otherId,
      targetNodeName: "b",
      address: "203.0.113.30",
      step: "staging",
      message: "b could not reach the moved panel.",
      startedAt: Date.now() - 30_000,
      at: Date.now(),
    });
    const status = (await callOp(panel, panelMove.status, {}, { cookie: owner.cookie })).body;
    // Delete the old copy stays on the card, with the failure next to it.
    expect(status).toMatchObject({
      state: "done",
      side: "new",
      moveId: done.moveId,
      fromNodeId: fromId,
      oldCopyRemoved: false,
      error: { step: "staging", message: "b could not reach the moved panel." },
    });
    // Once it is deleted, the failure is what the card shows.
    setSetting(panel.deps.db, "panelMoveDone", { ...done, oldCopyRemoved: true });
    expect((await callOp(panel, panelMove.status, {}, { cookie: owner.cookie })).body).toMatchObject({
      state: "failed",
      moveId: "f".repeat(16),
    });
    // So it does once the old node was removed: nothing is left to delete.
    setSetting(panel.deps.db, "panelMoveDone", { ...done, fromNodeId: "0".repeat(16) });
    expect((await callOp(panel, panelMove.status, {}, { cookie: owner.cookie })).body.state).toBe("failed");
  });

  test("never deletes the data of the node the panel runs on", async () => {
    setSetting(panel.deps.db, "panelMoveDone", { ...arrival(), at: Date.now() });
    const res = await callOp(panel, panelMove.removeOldCopy, {}, { cookie: owner.cookie });
    expect(res.body.error.details.reason).toBe("runsHere");
    expect(fleet.of("removeOldPanel")).toEqual([]);
  });
});

describe("a restart of the old panel in the middle", () => {
  const out = (phase: PanelMoveOut["phase"]): PanelMoveOut => ({
    moveId: "q".repeat(16),
    targetNodeId: targetId,
    targetNodeName: "new",
    address: "203.0.113.20",
    fromNodeId: fromId,
    fromNodeName: "old",
    phase,
    staged: [],
    leftBehind: [],
    domain: null,
    startedAt: Date.now() - 10_000,
    at: Date.now() - 5000,
  });

  test.each(["registry", "shipping", "starting"] as const)(
    "restarted at %s, before any node knew the address: carry on, clean up the target when it is back",
    async (phase) => {
      setSetting(panel.deps.db, "panelMoveOut", out(phase));
      expect(recoverMoveOut(panel.deps)).toBe("undone");
      expect(writePause(panel.deps.db)).toBeNull();
      expect(getSetting(panel.deps.db, "panelMoveOut")).toBeUndefined();
      expect(getSetting(panel.deps.db, "panelMoveCleanups")).toEqual([
        { moveId: "q".repeat(16), abortNodeId: targetId, clearNodeIds: [], at: expect.any(Number) },
      ]);
      expect((await callOp(panel, panelMove.status, {}, { cookie: owner.cookie })).body).toMatchObject({
        state: "failed",
        error: { step: phase },
      });
      await runCleanups(panel.deps, targetId);
      expect(fleet.of("abortMovedPanel")).toEqual([{ nodeId: targetId, method: "abortMovedPanel", request: { moveId: "q".repeat(16) } }]);
      expect(getSetting(panel.deps.db, "panelMoveCleanups")).toBeUndefined();
    },
  );

  test("restarted while nodes were told the address: nothing was committed, so the move is undone everywhere", async () => {
    // The journal names every node a StagePanelAddress went to, landed or not.
    setSetting(panel.deps.db, "panelMoveOut", { ...out("staging"), staged: [targetId, otherId, fromId] });
    expect(recoverMoveOut(panel.deps)).toBe("undone");
    expect(writePause(panel.deps.db)).toBeNull();
    expect(panel.runner.held).toBe(false);
    expect(getSetting(panel.deps.db, "panelMoveOut")).toBeUndefined();
    expect(getSetting(panel.deps.db, "panelMoveCleanups")).toEqual([
      { moveId: "q".repeat(16), abortNodeId: targetId, clearNodeIds: [targetId, otherId, fromId], at: expect.any(Number) },
    ]);
    const status = (await callOp(panel, panelMove.status, {}, { cookie: owner.cookie })).body;
    expect(status).toMatchObject({ state: "failed", error: { step: "staging", message: expect.stringContaining("undone") } });
    expect((await callOp(panel, settings.updateGeneral, { name: "back" }, { cookie: owner.cookie })).status).toBe(200);
    for (const id of [targetId, otherId, fromId]) await runCleanups(panel.deps, id);
    expect(fleet.of("abortMovedPanel").map((c) => c.nodeId)).toEqual([targetId]);
    expect(
      fleet
        .of("clearPanelAddress")
        .map((c) => c.nodeId)
        .sort(),
    ).toEqual([fromId, otherId, targetId].sort());
    expect(getSetting(panel.deps.db, "panelMoveCleanups")).toBeUndefined();
  });

  test("restarted while it undid a move: the undo finishes from the journal, with the failure it had", async () => {
    setSetting(panel.deps.db, "panelMoveOut", {
      ...out("aborting"),
      staged: [targetId, otherId],
      abortStep: "staging",
      abortMessage: "b could not reach the moved panel.",
    });
    expect(recoverMoveOut(panel.deps)).toBe("undone");
    expect(writePause(panel.deps.db)).toBeNull();
    expect(getSetting(panel.deps.db, "panelMoveCleanups")).toEqual([
      { moveId: "q".repeat(16), abortNodeId: targetId, clearNodeIds: [targetId, otherId], at: expect.any(Number) },
    ]);
    expect(getSetting(panel.deps.db, "panelMoveFailure")).toMatchObject({ step: "staging", message: "b could not reach the moved panel." });
  });

  test("a failure records the undo before it starts, so a restart in the middle finishes it", async () => {
    const gate = held({});
    fleet.answers.set("stagePanelAddress", (nodeId) => {
      if (nodeId === otherId) throw agentRefusal("UNAVAILABLE", "no route");
      return {};
    });
    fleet.answers.set("abortMovedPanel", gate.answer);
    await start();
    await gate.started;
    expect(getSetting(panel.deps.db, "panelMoveOut")).toMatchObject({ phase: "aborting", abortStep: "staging" });
    gate.release();
    await waitForState("failed");
    expect(getSetting(panel.deps.db, "panelMoveOut")).toBeUndefined();
  });

  test("restarted after the commit was sent: read-only again, the commit goes out again, then the switch", async () => {
    const release = held({});
    fleet.answers.set("commitMovedPanel", release.answer);
    setSetting(panel.deps.db, "panelMoveOut", {
      ...out("committing"),
      staged: [targetId, otherId, fromId],
      by: "owner@example.com",
      waitingSince: Date.now() - 60_000,
    });
    expect(recoverMoveOut(panel.deps)).toBe("resumed");
    // Before any agent is back: nothing goes to the target from here, no job runs, changes wait.
    expect(panel.deps.agents.desired.isHeld(targetId)).toBe(true);
    expect(panel.runner.held).toBe(true);
    expect(writePause(panel.deps.db)).toMatchObject({ reason: "moving", agentsClosed: false });
    await release.started;
    const waiting = moveStatus(panel.deps, true);
    expect(waiting).toMatchObject({ state: "running", step: "switching", canCancel: false, canForceCancel: false });
    expect(waiting.waitingSince).toBe(new Date(getSetting(panel.deps.db, "panelMoveOut")?.waitingSince ?? 0).toISOString());
    expect((await callOp(panel, settings.updateGeneral, { name: "x" }, { cookie: owner.cookie })).body.error.details.reason).toBe(
      "panelMoving",
    );
    release.release();
    const done = await waitForState("done");
    expect(done).toMatchObject({ side: "old", moveId: "q".repeat(16) });
    expect(fleet.sequence()).toEqual(["commitMovedPanel", "retirePanel"]);
    expect(fleet.reconnects.sort()).toEqual([otherId, targetId].sort());
    expect(writePause(panel.deps.db)).toMatchObject({ reason: "moved", agentsClosed: true });
  });

  test("restarted after the commit was sent and the target refuses it for sure: undone, the hold released", async () => {
    // No moved panel of this move runs there (the fleet answers notStarted).
    setSetting(panel.deps.db, "panelMoveOut", { ...out("committing"), staged: [targetId, otherId] });
    expect(recoverMoveOut(panel.deps)).toBe("resumed");
    const failed = await waitForState("failed");
    expect(failed.error).toMatchObject({ step: "switching", message: expect.stringContaining("new did not take the switch") });
    expect(panel.deps.agents.desired.isHeld(targetId)).toBe(false);
    expect(panel.runner.held).toBe(false);
    expect(writePause(panel.deps.db)).toBeNull();
    expect(fleet.of("abortMovedPanel").map((c) => c.nodeId)).toEqual([targetId]);
    expect(
      fleet
        .of("clearPanelAddress")
        .map((c) => c.nodeId)
        .sort(),
    ).toEqual([otherId, targetId].sort());
  });

  test.each(["switching", "moved"] as const)("restarted at %s, past the commit: stay retired so two panels never run", async (phase) => {
    setSetting(panel.deps.db, "panelMoveOut", out(phase));
    expect(recoverMoveOut(panel.deps)).toBe("retired");
    expect(writePause(panel.deps.db)).toMatchObject({ reason: "moved", agentsClosed: true });
    expect(panel.runner.held).toBe(true);
    const status = (await callOp(panel, panelMove.status, {}, { cookie: owner.cookie })).body;
    expect(status).toMatchObject({ state: "done", side: "old", newUrl: "http://203.0.113.20:3000" });
    const member = await createUser(panel, "member");
    const banner = (await callOp(panel, panelMove.status, {}, { cookie: member.cookie })).body;
    expect(banner).toMatchObject({
      state: "done",
      side: "old",
      targetNodeName: "new",
      newUrl: "http://203.0.113.20:3000",
      targetAddress: null,
      fromNodeId: null,
    });
    expect((await check()).body.blocks.map((b: { code: string }) => b.code)).toContain("moveRunning");
  });
});

describe("agents while the panel moves", () => {
  test("joins wait without a rejection, known nodes connect, reports wait; at the switch connects get 503", async () => {
    const url = (() => {
      panel.app.listen({ hostname: "127.0.0.1", port: 0, websocket: panelWebsocket });
      return `http://127.0.0.1:${panel.app.server?.port}`;
    })();
    // The real hub for this one: sessions register on it.
    panel.deps.agents = Object.getPrototypeOf(fleet.hub);
    try {
      setWritePause(panel.deps.db, { reason: "moving", targetName: "new", agentsClosed: false });
      const joining = new FakeAgent({ url, panelId: panel.deps.panelId, token: addJoinToken(panel), capabilities: ["state.sync.v1"] });
      await joining.connect();
      expect(joining.rejected).toBeNull();
      expect(joining.nodeId).toBe("");
      expect(joining.closed).toBe(true);
      expect(panel.deps.db.select().from(nodes).all()).toHaveLength(3);

      const key = agentKey();
      panel.deps.db
        .update(nodes)
        .set({ publicKey: Buffer.from(key.publicKey) })
        .where(eq(nodes.id, otherId))
        .run();
      const known = new FakeAgent({
        url,
        panelId: panel.deps.panelId,
        nodeId: otherId,
        key,
        capabilities: ["state.sync.v1", "panel.report.v1"],
      });
      await known.connect();
      expect(known.nodeId).toBe(otherId);
      const report = await known
        .callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
          outboxId: 7n,
          event: create(EventSchema, { payload: { case: "nodeAlert", value: {} } }),
        })
        .catch((error: { code: number }) => error.code);
      expect(report).toBe(StatusCode.UNAVAILABLE);
      await known.close();

      setWritePause(panel.deps.db, { reason: "moving", targetName: "new", agentsClosed: true });
      const late = new FakeAgent({ url, panelId: panel.deps.panelId, nodeId: otherId, key });
      await expect(late.connect()).rejects.toBeDefined();
      expect(panel.deps.agents.isOnline(otherId)).toBe(false);
      // Back to normal once the pause ends.
      setWritePause(panel.deps.db, null);
      const back = new FakeAgent({ url, panelId: panel.deps.panelId, nodeId: otherId, key });
      await back.connect();
      expect(back.nodeId).toBe(otherId);
      await back.close();
    } finally {
      setWritePause(panel.deps.db, null);
      await panel.app.stop(true);
    }
  });
});

test("audit rows of the move never hold a secret", async () => {
  await start();
  await waitForState("done");
  const rows = panel.deps.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actorType, "system")))
    .all();
  const text = JSON.stringify(rows);
  expect(text).not.toContain(
    await Bun.file(join(dataDir, "master.key"))
      .text()
      .then((s) => s.trim()),
  );
  expect(text).not.toContain("PRIVATE KEY");
});
