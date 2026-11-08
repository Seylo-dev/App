// Node ops over HTTP (pipeline, permissions, audit) against fake agents:
// nodes, cleanup, logs, metrics, terminals, files and updates.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { cleanup, files, logs, metrics, nodes as nodeOps, terminals, updates } from "@seylo/ops";
import { NodeCheckStatus, ReportEventRequestSchema, ReportEventResponseSchema, StatusCode, UpdateTarget } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { freshSignInMs } from "../src/auth/fresh";
import { auditLog, nodes, servicePlacements, sessions, updateSteps, volumes } from "../src/db/schema";
import { releaseSource } from "../src/modules/updates/manifest";
import { type FakeAgent, FakeStatus } from "./fake-agent";
import { callOp, createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen, seedProject, seedService } from "./hub-helpers";

let panel: TestPanel;
let url: string;
let owner: Awaited<ReturnType<typeof createUser>>;
const agents: FakeAgent[] = [];

beforeEach(async () => {
  panel = testPanel();
  url = listen(panel);
  owner = await createUser(panel, "owner");
});
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

async function join(options: Parameters<typeof joinAgent>[2] = {}) {
  const agent = await joinAgent(panel, url, options);
  agents.push(agent);
  return agent;
}

const ok = async <T>(promise: Promise<{ status: number; body: T }>) => {
  const res = await promise;
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

const sample = (at: Date, cpu: number, rx: bigint, services: { serviceId: string; cpu: number; mem: bigint }[] = []) => ({
  time: timestampFromDate(at),
  payload: {
    case: "metrics" as const,
    value: {
      time: timestampFromDate(at),
      node: {
        cpuPercent: cpu,
        memoryUsedBytes: 1000n,
        memoryTotalBytes: 4000n,
        diskUsedBytes: 10n,
        diskTotalBytes: 100n,
        networkRxBytes: rx,
        networkTxBytes: rx,
      },
      services: services.map((s) => ({ serviceId: s.serviceId, cpuPercent: s.cpu, memoryUsedBytes: s.mem })),
    },
  },
});

describe("nodes", () => {
  test("join token, list and detail with live facts, usage and services", async () => {
    // "Build images on this node" is on by default.
    const token = await ok(callOp(panel, nodeOps.createJoinToken, {}, { cookie: owner.cookie }));
    expect(token.command).toContain(token.token);
    expect(token.command).toContain("join --panel");
    expect(token.canBuild).toBe(true);
    const open = await ok(callOp(panel, nodeOps.listJoinTokens, {}, { cookie: owner.cookie }));
    expect(open.tokens.map((t: { id: string; canBuild: boolean }) => [t.id, t.canBuild])).toEqual([[token.tokenId, true]]);

    const agent = await join({
      token: token.token,
      facts: { hostname: "edge", memoryTotalBytes: 1n << 30n, cpuCores: 2, agentVersion: "dev" },
    });
    const project = seedProject(panel);
    const web = seedService(panel, project.id, agent.nodeId, { name: "web" });
    agent.event(sample(new Date(), 12.5, 100n));
    await Bun.sleep(30);

    const list = await ok(callOp(panel, nodeOps.list, {}, { cookie: owner.cookie }));
    expect(list.nodes).toHaveLength(1);
    expect(list.nodes[0]).toMatchObject({
      id: agent.nodeId,
      status: "online",
      isPanelNode: true,
      serviceCount: 1,
      canBuild: true,
      canBuildWarning: "Less than 2 GB of memory",
    });
    expect(list.nodes[0].usage.cpuPercent).toBe(12.5);
    expect((await ok(callOp(panel, nodeOps.listJoinTokens, {}, { cookie: owner.cookie }))).tokens).toEqual([]);

    const detail = await ok(callOp(panel, nodeOps.get, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    expect(detail.capabilities).toContain("fs.basic.v1");
    expect(detail.services).toMatchObject([{ serviceId: web.id, serviceName: "web", replicas: 1 }]);
    expect(detail.desiredRevision).toBeGreaterThan(0);
  });

  test("an unticked Build images makes a node that does not build, and the audit row says who chose it", async () => {
    const off = await ok(callOp(panel, nodeOps.createJoinToken, { canBuild: false }, { cookie: owner.cookie }));
    expect(off.canBuild).toBe(false);
    const on = await ok(callOp(panel, nodeOps.createJoinToken, { canBuild: true }, { cookie: owner.cookie }));
    const open = await ok(callOp(panel, nodeOps.listJoinTokens, {}, { cookie: owner.cookie }));
    expect(Object.fromEntries(open.tokens.map((t: { id: string; canBuild: boolean }) => [t.id, t.canBuild]))).toEqual({
      [off.tokenId]: false,
      [on.tokenId]: true,
    });

    // The node asks to build (config.yml can_build): the token decides.
    const agent = await join({ token: off.token, facts: { hostname: "edge", canBuild: true, agentVersion: "dev" } });
    expect(panel.deps.db.select().from(nodes).where(eq(nodes.id, agent.nodeId)).get()?.canBuild).toBe(false);
    await panel.deps.agents.desired.settled();
    expect((await agent.waitFor("SyncDesired")).at(-1).state.settings.maxParallelBuilds).toBe(0);

    const audited = panel.deps.db
      .select({ input: auditLog.input, actor: auditLog.actorId })
      .from(auditLog)
      .where(eq(auditLog.opId, "nodes.createJoinToken"))
      .all();
    expect(audited.map((r) => r.input)).toEqual([{ canBuild: false }, { canBuild: true }]);
    expect(audited.every((r) => r.actor === owner.user.id)).toBe(true);
  });

  test("a join token asked for with {} is audited as the build node it makes", async () => {
    // The 0.2.0 shape, still valid for API keys: before 0.2.1 it made a node that does not build.
    const bearer = createApiKey(panel, owner.user.id);
    const token = await ok(callOp(panel, nodeOps.createJoinToken, {}, { bearer }));
    expect(token.canBuild).toBe(true);
    // A refused attempt (no fresh sign-in on this session) says what it asked for too.
    const stale = await createUser(panel, "owner");
    const signedIn = new Date(Date.now() - freshSignInMs - 60_000);
    panel.deps.db.update(sessions).set({ createdAt: signedIn, reauthAt: null }).where(eq(sessions.userId, stale.user.id)).run();
    const refused = await callOp(panel, nodeOps.createJoinToken, {}, { cookie: stale.cookie });
    expect(refused.body.error?.details?.reason).toBe("reauth");

    const audited = panel.deps.db
      .select({ input: auditLog.input, actor: auditLog.actorId, error: auditLog.errorCode })
      .from(auditLog)
      .where(eq(auditLog.opId, "nodes.createJoinToken"))
      .all();
    expect(audited).toEqual([
      { input: { canBuild: true }, actor: owner.user.id, error: null },
      { input: { canBuild: true }, actor: stale.user.id, error: "FORBIDDEN" },
    ]);
  });

  test("settings changes are audited, published and reach the agent", async () => {
    const agent = await join({ facts: { wings: { version: "1.11" } } });
    const syncsBefore = agent.requests("SyncDesired").length;
    const renamed = await ok(callOp(panel, nodeOps.rename, { nodeId: agent.nodeId, name: "de-1" }, { cookie: owner.cookie }));
    expect(renamed.name).toBe("de-1");
    await ok(callOp(panel, nodeOps.setTags, { nodeId: agent.nodeId, tags: ["eu", "games"] }, { cookie: owner.cookie }));
    const games = await ok(callOp(panel, nodeOps.setGamesFirstCpu, { nodeId: agent.nodeId, enabled: true }, { cookie: owner.cookie }));
    expect(games).toMatchObject({ gamesFirstCpu: true, wings: { detected: true, version: "1.11" }, tags: ["eu", "games"] });
    const detail = await ok(
      callOp(
        panel,
        nodeOps.updateSettings,
        { nodeId: agent.nodeId, wildcardDomain: "de1.example.com", logRetention: { maxBytesPerService: 50 << 20, maxAgeDays: 7 } },
        { cookie: owner.cookie },
      ),
    );
    expect(detail).toMatchObject({ wildcardDomain: "de1.example.com", logRetention: { maxAgeDays: 7 } });
    await panel.deps.agents.desired.settled();
    const syncs = await agent.waitFor("SyncDesired", syncsBefore + 1);
    const settings = syncs.at(-1).state.settings;
    expect(settings).toMatchObject({ gamesFirstCpu: true, wildcardDomain: "de1.example.com" });
    expect(settings.logRetention.maxBytesPerService).toBe(50n << 20n);

    const audited = panel.deps.db
      .select({ opId: auditLog.opId })
      .from(auditLog)
      .all()
      .map((r) => r.opId);
    expect(audited).toEqual(expect.arrayContaining(["nodes.rename", "nodes.setTags", "nodes.setGamesFirstCpu", "nodes.updateSettings"]));
  });

  test("games-first needs Wings; removal needs an empty node and is refused for the panel node", async () => {
    const panelNode = await join();
    const other = await join();
    const refused = await callOp(panel, nodeOps.setGamesFirstCpu, { nodeId: other.nodeId, enabled: true }, { cookie: owner.cookie });
    expect(refused.status).toBe(409);

    const project = seedProject(panel);
    const svc = seedService(panel, project.id, other.nodeId);
    const name = panel.deps.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, other.nodeId)).get()?.name ?? "";
    expect((await callOp(panel, nodeOps.remove, { nodeId: other.nodeId, confirmName: "wrong" }, { cookie: owner.cookie })).status).toBe(
      400,
    );
    expect((await callOp(panel, nodeOps.remove, { nodeId: other.nodeId, confirmName: name }, { cookie: owner.cookie })).status).toBe(409);
    panel.deps.db.delete(servicePlacements).where(eq(servicePlacements.serviceId, svc.id)).run();
    await ok(callOp(panel, nodeOps.remove, { nodeId: other.nodeId, confirmName: name }, { cookie: owner.cookie }));
    expect(panel.deps.agents.isOnline(other.nodeId)).toBe(false);

    const panelName = panel.deps.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, panelNode.nodeId)).get()?.name ?? "";
    expect(
      (await callOp(panel, nodeOps.remove, { nodeId: panelNode.nodeId, confirmName: panelName }, { cookie: owner.cookie })).status,
    ).toBe(409);
  });

  test("agent logs come from the node's journal through AgentLogs", async () => {
    const agent = await join();
    agent.handle("AgentLogs", () => ({
      lines: [
        { time: timestampFromDate(new Date("2026-11-05T10:00:00Z")), level: "info", line: "connected" },
        { time: timestampFromDate(new Date("2026-11-05T10:00:01Z")), level: "weird", line: "odd level" },
      ],
    }));
    const out = await ok(callOp(panel, nodeOps.agentLogs, { nodeId: agent.nodeId, tail: 50 }, { cookie: owner.cookie }));
    expect(out.entries).toEqual([
      { time: "2026-11-05T10:00:00.000Z", level: "info", line: "connected" },
      { time: "2026-11-05T10:00:01.000Z", level: "info", line: "odd level" },
    ]);
    expect(agent.requests("AgentLogs")[0].tail).toBe(50);
  });

  test("health checks are stored; reboot and Docker updates call the agent", async () => {
    const agent = await join();
    agent.handle("RunHealthCheck", () => ({
      results: [
        { id: "docker.reachable", title: "Docker", status: NodeCheckStatus.PASS },
        { id: "disk.free", title: "Disk", status: NodeCheckStatus.WARN, detail: "12% free", fixHint: "Clean up" },
      ],
    }));
    const report = await ok(callOp(panel, nodeOps.runHealthCheck, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    // The panel adds its own address check: this test node knows no public address.
    expect(report.summary).toEqual({ pass: 1, warn: 2, fail: 0, skipped: 0 });
    const stored = await ok(callOp(panel, nodeOps.healthReport, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    expect(stored.results[1]).toMatchObject({ id: "disk.free", status: "warn", fixHint: "Clean up" });
    expect(stored.results[2]).toMatchObject({ id: "network.publicAddress", status: "warn" });
    const list = await ok(callOp(panel, nodeOps.list, {}, { cookie: owner.cookie }));
    expect(list.nodes[0].health.worst).toBe("warn");

    agent.handle("Reboot", () => ({}));
    const name = list.nodes[0].name;
    await ok(callOp(panel, nodeOps.reboot, { nodeId: agent.nodeId, confirmName: name }, { cookie: owner.cookie }));
    expect(agent.requests("Reboot")[0].delay.seconds).toBe(5n);

    agent.handle("UpdateDocker", (req: { dryRun: boolean }) => ({
      fromVersion: "27.0",
      toVersion: req.dryRun ? "29.0" : "29.0",
      warning: req.dryRun ? "live-restore is off" : "",
    }));
    const dry = await ok(callOp(panel, nodeOps.updateDocker, { nodeId: agent.nodeId, dryRun: true }, { cookie: owner.cookie }));
    expect(dry).toEqual({ fromVersion: "27.0", toVersion: "29.0", runId: null, warning: "live-restore is off" });
    const real = await ok(callOp(panel, nodeOps.updateDocker, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    expect(real.runId).toBeString();
    const updateId = agent.requests("UpdateDocker").at(-1).updateId;
    await agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
      outboxId: 1n,
      event: {
        payload: {
          case: "updateResult",
          value: { target: UpdateTarget.DOCKER, updateId, success: true, fromVersion: "27.0", toVersion: "29.0" },
        },
      },
    });
    const history = await ok(callOp(panel, updates.history, {}, { cookie: owner.cookie }));
    expect(history.runs[0]).toMatchObject({
      id: real.runId,
      status: "succeeded",
      steps: [{ target: "docker", status: "succeeded", toVersion: "29.0" }],
    });
  });

  test("members without nodes.view are refused", async () => {
    const member = await createUser(panel, "member");
    expect((await callOp(panel, nodeOps.list, {}, { cookie: member.cookie })).status).toBe(403);
    expect((await callOp(panel, nodeOps.createJoinToken, {}, { cookie: member.cookie })).status).toBe(403);
  });

  test("nodes.choices offers members who may create services the nodes, without addresses", async () => {
    const agent = await join();
    panel.deps.db
      .update(nodes)
      .set({ name: "edge", wildcardDomain: "apps.example.com", publicIpv4: "203.0.113.7" })
      .where(eq(nodes.id, agent.nodeId))
      .run();
    const off = panel.deps.db
      .insert(nodes)
      .values({ name: "spare", publicKey: Buffer.alloc(32, 1), disabledAt: new Date() })
      .returning()
      .get();
    const project = seedProject(panel);

    const creator = await createUser(panel, "member");
    grant(panel, creator.user.id, "project", project.id, ["*"]);
    const offered = await ok(callOp(panel, nodeOps.choices, {}, { cookie: creator.cookie }));
    // The disabled node is not offered, and a choice carries no address, usage or settings.
    expect(offered.nodes).toEqual([
      { id: agent.nodeId, name: "edge", status: "online", wildcardDomain: "apps.example.com", arch: "amd64" },
    ]);
    expect(offered.nodes.some((n: { id: string }) => n.id === off.id)).toBe(false);

    // Viewers and accounts without grants cannot create anything, so they get nothing.
    const viewer = await createUser(panel, "member");
    grant(panel, viewer.user.id, "project", project.id, ["services.view"]);
    expect(await ok(callOp(panel, nodeOps.choices, {}, { cookie: viewer.cookie }))).toEqual({ nodes: [] });
    const stranger = await createUser(panel, "member");
    expect(await ok(callOp(panel, nodeOps.choices, {}, { cookie: stranger.cookie }))).toEqual({ nodes: [] });

    const all = await ok(callOp(panel, nodeOps.choices, {}, { cookie: owner.cookie }));
    expect(all.nodes.map((n: { name: string }) => n.name)).toEqual(["edge"]);
  });
});

describe("cleanup", () => {
  test("preview is a dry run; run prunes for real", async () => {
    const agent = await join();
    agent.handle("Prune", (req: { dryRun: boolean }) => ({
      reclaimedBytes: 2048n,
      removed: [req.dryRun ? "would remove image a" : "removed image a"],
    }));
    const preview = await ok(callOp(panel, cleanup.preview, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    expect(preview).toEqual({ nodeId: agent.nodeId, bytes: 2048, items: ["would remove image a"] });
    const run = await ok(callOp(panel, cleanup.run, { nodeId: agent.nodeId, orphanedServiceData: true }, { cookie: owner.cookie }));
    expect(run.items).toEqual(["removed image a"]);
    expect(agent.requests("Prune").map((r) => [r.dryRun, r.orphanedServiceData])).toEqual([
      [true, false],
      [false, true],
    ]);
  });
});

describe("logs", () => {
  test("search merges nodes newest first and pages with a cursor", async () => {
    const a = await join();
    const b = await join();
    const project = seedProject(panel);
    const svc = seedService(panel, project.id, a.nodeId);
    panel.deps.db.insert(servicePlacements).values({ serviceId: svc.id, nodeId: b.nodeId }).run();
    const at = (s: number) => timestampFromDate(new Date(Date.UTC(2026, 0, 1, 0, 0, s)));
    const lines = (node: string, seconds: number[]) => (req: { until?: { seconds: bigint } }) => ({
      entries: seconds
        .filter((s) => !req.until || BigInt(Date.UTC(2026, 0, 1, 0, 0, s) / 1000) <= req.until.seconds)
        .sort((x, y) => y - x)
        .map((s) => ({ time: at(s), line: `${node}${s}` })),
    });
    a.handle("LogsSearch", lines("a", [1, 3, 5]));
    b.handle("LogsSearch", lines("b", [2, 4, 6]));
    const page1 = await ok(callOp(panel, logs.search, { serviceId: svc.id, limit: 4 }, { cookie: owner.cookie }));
    expect(page1.entries.map((e: { line: string }) => e.line)).toEqual(["b6", "a5", "b4", "a3"]);
    const page2 = await ok(callOp(panel, logs.search, { serviceId: svc.id, limit: 4, cursor: page1.nextCursor }, { cookie: owner.cookie }));
    expect(page2.entries.map((e: { line: string }) => e.line)).toEqual(["b2", "a1"]);
    expect(page1.offlineNodeIds).toEqual([]);
  });

  test("follow hands out a ticket for a socket that streams the tail and new lines", async () => {
    const agent = await join();
    const project = seedProject(panel);
    const svc = seedService(panel, project.id, agent.nodeId);
    agent.handleStream("LogsFollow", async (req: { tail: number }, stream) => {
      await stream.send({ entries: [{ line: `tail ${req.tail}` }] });
      await Bun.sleep(20);
      await stream.send({ entries: [{ line: "live" }] });
      await new Promise((resolve) => stream.signal.addEventListener("abort", resolve));
    });
    const ticket = await ok(callOp(panel, logs.follow, { serviceId: svc.id, tail: 50 }, { cookie: owner.cookie }));
    const ws = new WebSocket(`${url.replace("http", "ws")}${ticket.url}`);
    const messages: { type: string; entries?: { line: string }[] }[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
    for (let i = 0; i < 100 && messages.flatMap((m) => m.entries ?? []).length < 2; i++) await Bun.sleep(10);
    expect(messages.flatMap((m) => m.entries ?? []).map((e) => e.line)).toEqual(["tail 50", "live"]);
    ws.close();

    // Tickets are single use.
    const again = new WebSocket(`${url.replace("http", "ws")}${ticket.url}`);
    const code = await new Promise<number>((resolve) => {
      again.onclose = (e) => resolve(e.code);
    });
    expect(code).toBe(4401);
  });
});

describe("metrics", () => {
  test("samples feed the live graphs, minute rollups and the service series", async () => {
    const agent = await join();
    const project = seedProject(panel);
    const svc = seedService(panel, project.id, agent.nodeId);
    const now = Date.now();
    const base = Math.floor(now / 60_000) * 60_000 - 3 * 60_000;
    // Three minutes of samples every 10 s, the network counter growing 1000 B/s.
    for (let i = 0; i < 18; i++) {
      agent.event(sample(new Date(base + i * 10_000), 10 + i, BigInt(i * 10_000), [{ serviceId: svc.id, cpu: 2, mem: 100n }]));
    }
    await Bun.sleep(100);
    const live = await ok(callOp(panel, metrics.node, { nodeId: agent.nodeId, range: "live" }, { cookie: owner.cookie }));
    expect(live.series.points.length).toBeGreaterThan(10);
    expect(live.series.points.at(-1).networkRxBytesPerSec).toBe(1000);
    const hour = await ok(callOp(panel, metrics.node, { nodeId: agent.nodeId, range: "1h" }, { cookie: owner.cookie }));
    // Two full minutes are written; the third is still open.
    expect(hour.series.points).toHaveLength(2);
    expect(hour.series.points[0].cpuPercent).toBeCloseTo(12.5);
    const day = await ok(callOp(panel, metrics.nodes, { range: "24h" }, { cookie: owner.cookie }));
    expect(day.nodes[0].points.length).toBeGreaterThan(0);

    const service = await ok(callOp(panel, metrics.service, { serviceId: svc.id, range: "1h" }, { cookie: owner.cookie }));
    expect(service.points[0]).toMatchObject({ cpuPercent: 2, memoryBytes: 100 });
    expect(service.current).toMatchObject([{ nodeId: agent.nodeId, cpuPercent: 2, memoryBytes: 100, memoryLimitBytes: null }]);

    const member = await createUser(panel, "member");
    expect((await ok(callOp(panel, metrics.summary, {}, { cookie: member.cookie }))).services).toEqual([]);
    grant(panel, member.user.id, "service", svc.id, ["metrics.view"]);
    expect((await ok(callOp(panel, metrics.summary, {}, { cookie: member.cookie }))).services).toEqual([
      { serviceId: svc.id, cpuPercent: 2, memoryBytes: 100 },
    ]);
  });
});

describe("terminals", () => {
  test("a shell ticket opens a socket that relays bytes and resizes", async () => {
    const agent = await join();
    const project = seedProject(panel);
    const svc = seedService(panel, project.id, agent.nodeId);
    const resizes: unknown[] = [];
    agent.handleStream("Shell", async (_first, stream) => {
      for (;;) {
        const msg = (await stream.recv()) as { message: { case: string; value: any } } | null;
        if (!msg) return;
        if (msg.message.case === "resize") resizes.push(msg.message.value);
        if (msg.message.case === "input") {
          const text = new TextDecoder().decode(msg.message.value);
          if (text === "exit\n") {
            await stream.send({ message: { case: "exitCode", value: 0 } });
            return;
          }
          await stream.send({ message: { case: "output", value: new TextEncoder().encode(`> ${text}`) } });
        }
      }
    });
    const member = await createUser(panel, "member");
    expect((await callOp(panel, terminals.openShell, { serviceId: svc.id }, { cookie: member.cookie })).status).toBe(403);

    const ticket = await ok(callOp(panel, terminals.openShell, { serviceId: svc.id, columns: 80, rows: 24 }, { cookie: owner.cookie }));
    expect(ticket.target.nodeId).toBe(agent.nodeId);
    const ws = new WebSocket(`${url.replace("http", "ws")}${ticket.url}`);
    ws.binaryType = "arraybuffer";
    const text: string[] = [];
    const control: { type: string; exitCode?: number }[] = [];
    ws.onmessage = (e) => {
      if (typeof e.data === "string") control.push(JSON.parse(e.data));
      else text.push(new TextDecoder().decode(e.data as ArrayBuffer));
    };
    await new Promise((resolve) => {
      ws.onopen = resolve;
    });
    ws.send(JSON.stringify({ type: "resize", columns: 100, rows: 30 }));
    ws.send(new TextEncoder().encode("ls\n"));
    for (let i = 0; i < 100 && text.length === 0; i++) await Bun.sleep(10);
    expect(text.join("")).toBe("> ls\n");
    ws.send(new TextEncoder().encode("exit\n"));
    for (let i = 0; i < 100 && !control.some((c) => c.type === "exit"); i++) await Bun.sleep(10);
    expect(control.map((c) => c.type)).toEqual(["ready", "exit"]);
    expect(resizes).toMatchObject([{ columns: 100, rows: 30 }]);
    const first = agent.requests("Shell")[0];
    expect(first.message.value.size).toMatchObject({ columns: 80, rows: 24 });
  });

  test("ready carries the user and working directory from the agent's ShellInfo", async () => {
    const agent = await join();
    const project = seedProject(panel);
    const svc = seedService(panel, project.id, agent.nodeId);
    agent.handleStream("Shell", async (_first, stream) => {
      await stream.send({
        message: { case: "info", value: { containerId: "c123", generation: 7n, user: "bun", workingDir: "/app", command: ["bash"] } },
      });
      await stream.send({ message: { case: "output", value: new TextEncoder().encode("$ ") } });
      await stream.recv();
    });
    const ticket = await ok(callOp(panel, terminals.openShell, { serviceId: svc.id }, { cookie: owner.cookie }));
    const ws = new WebSocket(`${url.replace("http", "ws")}${ticket.url}`);
    ws.binaryType = "arraybuffer";
    const control: Record<string, unknown>[] = [];
    const text: string[] = [];
    ws.onmessage = (e) => {
      if (typeof e.data === "string") control.push(JSON.parse(e.data));
      else text.push(new TextDecoder().decode(e.data as ArrayBuffer));
    };
    for (let i = 0; i < 200 && text.length === 0; i++) await Bun.sleep(10);
    expect(control[0]).toEqual({ type: "ready", containerId: "c123", generation: 7, user: "bun", workdir: "/app" });
    expect(text.join("")).toBe("$ ");
    ws.close();
  });
});

describe("files", () => {
  test("list, read, write and the download/upload links", async () => {
    const agent = await join();
    const project = seedProject(panel);
    const svc = seedService(panel, project.id, agent.nodeId);
    panel.deps.db.insert(volumes).values({ serviceId: svc.id, name: "data", mountPath: "/data" }).run();
    const store = new Map<string, Uint8Array>([["notes.txt", new TextEncoder().encode("hello")]]);
    agent.handle("FsList", () => ({
      entries: [...store]
        .map(([name, bytes]) => ({ name, path: name, isDir: false, size: BigInt(bytes.length), mode: 0o644 }))
        .concat([{ name: "sub", path: "sub", isDir: true, size: 0n, mode: 0o755 }]),
    }));
    agent.handle("FsStat", (req: { path: string }) => ({
      info: { name: req.path, path: req.path, size: BigInt(store.get(req.path)?.length ?? 0) },
    }));
    agent.handleStream("FsRead", async (req: { path: string }, stream) => {
      await stream.write(store.get(req.path) ?? new Uint8Array());
      return { info: { name: req.path, path: req.path, size: BigInt(store.get(req.path)?.length ?? 0) } };
    });
    agent.handleStream("FsWrite", async (req: { path: string }, stream) => {
      const chunks: Uint8Array[] = [];
      for (;;) {
        const chunk = await stream.read();
        if (!chunk) break;
        chunks.push(chunk);
      }
      store.set(req.path, Buffer.concat(chunks));
      return { info: { name: req.path, path: req.path, size: BigInt(Buffer.concat(chunks).length) } };
    });
    const root = { serviceId: svc.id, volume: "data" };

    const listing = await ok(callOp(panel, files.list, { ...root, path: "" }, { cookie: owner.cookie }));
    expect(listing.entries.map((e: { name: string }) => e.name)).toEqual(["sub", "notes.txt"]);
    const read = await ok(callOp(panel, files.readFile, { ...root, path: "notes.txt" }, { cookie: owner.cookie }));
    expect(read).toMatchObject({ encoding: "utf8", content: "hello" });
    await ok(
      callOp(
        panel,
        files.write,
        { ...root, path: "bin.dat", content: Buffer.from([0, 1, 2]).toString("base64"), encoding: "base64" },
        { cookie: owner.cookie },
      ),
    );
    expect([...(store.get("bin.dat") ?? [])]).toEqual([0, 1, 2]);
    const binary = await ok(callOp(panel, files.readFile, { ...root, path: "bin.dat" }, { cookie: owner.cookie }));
    expect(binary).toMatchObject({ encoding: "base64", content: "AAEC" });
    expect((await callOp(panel, files.list, { ...root, volume: "nope" }, { cookie: owner.cookie })).status).toBe(404);
    // Writes are audited without their content.
    const audit = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "files.write")).get();
    expect(JSON.stringify(audit?.input)).not.toContain("AAEC");

    const big = new Uint8Array(3 << 20).map((_, i) => i % 7);
    const up = await ok(callOp(panel, files.uploadTicket, { ...root, path: "big.bin", sizeBytes: big.length }, { cookie: owner.cookie }));
    const put = await fetch(`${url}${up.url}`, { method: "PUT", body: big });
    expect(put.status).toBe(200);
    expect(store.get("big.bin")?.length).toBe(big.length);
    const down = await ok(callOp(panel, files.downloadTicket, { ...root, path: "big.bin" }, { cookie: owner.cookie }));
    const got = await fetch(`${url}${down.url}`);
    expect(got.headers.get("content-disposition")).toContain('filename="big.bin"');
    expect(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(big))).toBe(true);
    expect((await fetch(`${url}${down.url}`)).status).toBe(401);
  });
});

/** Minisign signature file for `message` (prehashed "ED"), as `minisign -S` writes it. */
function minisign(message: Uint8Array) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const keyId = Buffer.from("0123456789abcdef", "hex");
  const pub = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
  const sig = sign(null, createHash("blake2b512").update(message).digest(), privateKey);
  const trusted = "timestamp:1762300000\tfile:manifest.json";
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
  const file = `untrusted comment: signature\n${Buffer.concat([Buffer.from("ED"), keyId, sig]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
  return { pub, file };
}

describe("updates", () => {
  const original = { ...releaseSource };
  afterEach(() => Object.assign(releaseSource, original));

  function serveRelease(manifest: object, tamper = false) {
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    const { pub, file } = minisign(bytes);
    releaseSource.publicKey = pub;
    releaseSource.fetch = async (u: string) => {
      if (u === releaseSource.latestUrl) {
        return Response.json({
          assets: [
            { name: "manifest.json", browser_download_url: "https://example.test/manifest.json" },
            { name: "manifest.json.minisig", browser_download_url: "https://example.test/manifest.json.minisig" },
          ],
        });
      }
      if (u.endsWith(".minisig")) return new Response(file);
      return new Response(tamper ? new TextEncoder().encode(JSON.stringify({ ...manifest, version: "9.9.9" })) : bytes);
    };
  }

  const manifest = { version: "0.9.0", minAgent: "0.7.0", panel: { image: "ghcr.io/x/panel", digest: "sha256:aa" }, agents: {} };

  test("check verifies the signed manifest; a tampered one is refused", async () => {
    serveRelease(manifest, true);
    const bad = await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
    expect(bad.checkError).toContain("signature");
    expect(bad.panel.latestVersion).toBeNull();
    serveRelease(manifest);
    const good = await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
    expect(good).toMatchObject({ checkError: null, panel: { latestVersion: "0.9.0", currentVersion: "dev" } });
    // A release the panel has only checked does not raise the floor: a dev panel has none.
    expect(panel.deps.agents.minimumAgentVersion()).toBeNull();
    const auto = await ok(callOp(panel, updates.setAutoUpdate, { enabled: true }, { cookie: owner.cookie }));
    expect(auto.autoUpdate).toBe(true);
  });

  test("the agent floor is the running release's minAgent, never a newer checked one's", async () => {
    const config = panel.deps.config as { version: string };
    const running = config.version;
    try {
      config.version = "0.8.0";
      // 0.9.0 needs agents of 0.8.5 or newer; this panel still runs 0.8.0 (N-2 floor 0.6.0).
      serveRelease({ ...manifest, minAgent: "0.8.5" });
      await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
      // Before: 0.8.5, so every older agent was refused and updated itself ahead of the panel.
      expect(panel.deps.agents.minimumAgentVersion()).toBe("0.6.0");
      // Once the panel runs 0.9.0, its manifest's floor applies.
      config.version = "0.9.0";
      expect(panel.deps.agents.minimumAgentVersion()).toBe("0.8.5");
      // A later check that finds 0.10.0 (minAgent 0.9.5) keeps the running release's floor.
      serveRelease({ ...manifest, version: "0.10.0", minAgent: "0.9.5" });
      await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
      expect(panel.deps.agents.minimumAgentVersion()).toBe("0.8.5");
    } finally {
      config.version = running;
    }
  });

  test("updating a node sends the verified manifest and finishes on the agent's result", async () => {
    serveRelease(manifest);
    const agent = await join({ agentVersion: "0.8.0", facts: { agentVersion: "0.8.0" } });
    await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
    agent.handle("UpdateAgent", () => ({}));
    const run = await ok(callOp(panel, updates.updateNode, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    expect(run).toMatchObject({
      status: "running",
      targetVersion: "0.9.0",
      steps: [{ target: "agent", status: "pending", fromVersion: "0.8.0" }],
    });
    expect((await callOp(panel, updates.updateNode, { nodeId: agent.nodeId }, { cookie: owner.cookie })).status).toBe(409);

    await panel.runner.runDue(panel.deps);
    const request = (await agent.waitFor("UpdateAgent"))[0];
    expect(request.targetVersion).toBe("0.9.0");
    expect(new TextDecoder().decode(request.manifest)).toContain('"0.9.0"');
    const stepId = request.updateId;
    expect(panel.deps.db.select().from(updateSteps).where(eq(updateSteps.id, stepId)).get()?.status).toBe("running");

    await agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
      outboxId: 9n,
      event: {
        payload: { case: "updateResult", value: { target: UpdateTarget.AGENT, updateId: stepId, success: true, toVersion: "0.9.0" } },
      },
    });
    await panel.runner.runDue(panel.deps);
    const status = await ok(callOp(panel, updates.status, {}, { cookie: owner.cookie }));
    expect(status.activeRun).toBeNull();
    const history = await ok(callOp(panel, updates.history, {}, { cookie: owner.cookie }));
    expect(history.runs[0]).toMatchObject({ status: "succeeded", doneSteps: 1, totalSteps: 1 });
  });

  test("a node busy updating itself (on reconnect) keeps its step running until it reports the version", async () => {
    serveRelease(manifest);
    const agent = await join({ agentVersion: "0.8.0", facts: { agentVersion: "0.8.0" } });
    await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
    agent.handle("UpdateAgent", () => {
      throw new FakeStatus(StatusCode.ABORTED, "another update is in progress on this node");
    });
    await ok(callOp(panel, updates.updateNode, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    await panel.runner.runDue(panel.deps);
    const stepId = (await agent.waitFor("UpdateAgent"))[0].updateId;
    expect(panel.deps.db.select().from(updateSteps).where(eq(updateSteps.id, stepId)).get()?.status).toBe("running");

    agent.event({ payload: { case: "nodeFacts", value: { agentVersion: "0.9.0" } } });
    await Bun.sleep(50);
    panel.deps.db.update(updateSteps).set({ startedAt: new Date() }).where(eq(updateSteps.id, stepId)).run();
    const { advanceRun } = await import("../src/modules/updates/runs");
    const runId = panel.deps.db.select().from(updateSteps).where(eq(updateSteps.id, stepId)).get()?.runId as string;
    while ((await advanceRun(panel.deps, runId)) === 0) {}
    const history = await ok(callOp(panel, updates.history, {}, { cookie: owner.cookie }));
    expect(history.runs[0]).toMatchObject({ status: "succeeded", doneSteps: 1, totalSteps: 1 });
  });
});
