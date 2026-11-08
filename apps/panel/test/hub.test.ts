// Agent hub against the fake agent over a real WebSocket: streams with flow
// control, raw byte methods, PanelService handlers, the registry tunnel
// relay, the agent version floor and desired-state sync.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  GetDesiredStateRequestSchema,
  GetDesiredStateResponseSchema,
  HelloRejectReason,
  ReportCrashRequestSchema,
  ReportCrashResponseSchema,
  ReportEventRequestSchema,
  ReportEventResponseSchema,
  StatusCode,
} from "@seylo/proto";
import { eq } from "drizzle-orm";
import { agentReports, crashReports, servicePlacements, services } from "../src/db/schema";
import { flusherFor } from "../src/modules/nodes/index";
import { allCapabilities, FakeAgent, FakeStatus } from "./fake-agent";
import { type TestPanel, testPanel } from "./helpers";
import { addJoinToken, joinAgent, listen, seedProject, seedService } from "./hub-helpers";

let panel: TestPanel;
let url: string;
const agents: FakeAgent[] = [];

beforeEach(() => {
  panel = testPanel();
  url = listen(panel);
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

const svcId = "svc0000000000001";

/** The rejection of a promise (Bun's expect().rejects drives socket I/O oddly, so await it plainly). */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("streams", () => {
  test("server streaming respects the window: the agent waits until the panel reads", async () => {
    const agent = await join();
    let sent = 0;
    agent.handleStream("LogsFollow", async (_first, stream) => {
      for (let i = 0; i < 200; i++) {
        await stream.send({ entries: [{ line: `line ${i} ${"x".repeat(1000)}` }] });
        sent++;
      }
    });
    const logs = panel.deps.agents.open(
      agent.nodeId,
      "logsFollow",
      { target: { case: "serviceId", value: svcId } },
      { initialWindow: 16 << 10 },
    );
    await Bun.sleep(100);
    // About 16 KiB fit before the first grant: far fewer than 200 messages.
    expect(sent).toBeLessThan(30);
    const lines: string[] = [];
    for await (const batch of logs) for (const e of batch.entries) lines.push(e.line);
    expect(lines).toHaveLength(200);
    expect(lines[199]).toStartWith("line 199 ");
    await expect(logs.done).resolves.toEqual({ message: "" });
  });

  test("bidi streams carry requests both ways and half-close ends the agent's reads", async () => {
    const agent = await join();
    agent.handleStream("Shell", async (_first, stream) => {
      for (;;) {
        const msg = (await stream.recv()) as { message: { case: string; value: Uint8Array } } | null;
        if (!msg) break;
        if (msg.message.case === "input") await stream.send({ message: { case: "output", value: msg.message.value } });
      }
      await stream.send({ message: { case: "exitCode", value: 3 } });
    });
    const shell = panel.deps.agents.open(agent.nodeId, "shell", { message: { case: "open", value: { serviceId: svcId } } });
    await shell.send({ message: { case: "input", value: new TextEncoder().encode("echo hi\n") } });
    shell.closeSend();
    const out: string[] = [];
    let exit = -1;
    for await (const res of shell) {
      if (res.message.case === "output") out.push(new TextDecoder().decode(res.message.value));
      if (res.message.case === "exitCode") exit = res.message.value;
    }
    expect(out.join("")).toBe("echo hi\n");
    expect(exit).toBe(3);
  });

  test("raw download and upload move bytes and return the response", async () => {
    const agent = await join();
    const big = new Uint8Array(1_000_000).map((_, i) => i % 251);
    agent.handleStream("FsRead", async (_req, stream) => {
      await stream.write(big);
      return { info: { name: "big.bin", size: BigInt(big.length) } };
    });
    let received = 0;
    agent.handleStream("FsWrite", async (_req, stream) => {
      for (;;) {
        const chunk = await stream.read();
        if (!chunk) break;
        received += chunk.length;
      }
      return { info: { name: "up.bin", size: BigInt(received) } };
    });

    const download = panel.deps.agents.openRaw(agent.nodeId, "fsRead", { root: { serviceId: svcId, volume: "data" }, path: "big.bin" });
    const chunks: Uint8Array[] = [];
    for await (const chunk of download.body) chunks.push(chunk);
    const joined = Buffer.concat(chunks);
    expect(joined.length).toBe(big.length);
    expect(joined.equals(Buffer.from(big))).toBe(true);
    expect((await download.response).info?.name).toBe("big.bin");

    const upload = panel.deps.agents.openRaw(agent.nodeId, "fsWrite", { root: { serviceId: svcId, volume: "data" }, path: "up.bin" });
    await upload.writer.write(big);
    upload.writer.end();
    expect((await upload.response).info?.size).toBe(BigInt(big.length));
    expect(received).toBe(big.length);
  });

  test("breaking out of a read cancels the stream on the agent", async () => {
    const agent = await join();
    let aborted = false;
    agent.handleStream("LogsFollow", async (_first, stream) => {
      stream.signal.addEventListener("abort", () => {
        aborted = true;
      });
      for (let i = 0; !stream.signal.aborted && i < 10_000; i++) {
        await stream.send({ entries: [{ line: `l${i}` }] }).catch(() => {});
        await Bun.sleep(1);
      }
    });
    const logs = panel.deps.agents.open(agent.nodeId, "logsFollow", { target: { case: "serviceId", value: svcId } });
    let n = 0;
    for await (const _ of logs) if (++n === 3) break;
    expect(await failure(logs.done)).toMatchObject({ details: { reason: "cancelled" } });
    for (let i = 0; i < 50 && !aborted; i++) await Bun.sleep(10);
    expect(aborted).toBe(true);
  });

  test("an agent error status rejects the stream with the mapped OpError; a dropped node rejects with offline", async () => {
    const agent = await join();
    agent.handleStream("LogsFollow", async () => {
      throw new FakeStatus(StatusCode.NOT_FOUND, "no such service here");
    });
    const logs = panel.deps.agents.open(agent.nodeId, "logsFollow", { target: { case: "serviceId", value: svcId } });
    expect(await failure(logs.done)).toMatchObject({ code: "NOT_FOUND", message: "no such service here" });

    agent.handleStream("WatchMetrics", async () => {
      await Bun.sleep(10_000);
    });
    const watch = panel.deps.agents.open(agent.nodeId, "watchMetrics", {});
    await Bun.sleep(20);
    await agent.close();
    expect(await failure(watch.done)).toMatchObject({ code: "UNAVAILABLE", details: { reason: "offline" } });
    expect(() => panel.deps.agents.open(agent.nodeId, "watchMetrics", {})).toThrow(/offline/);
  });
});

describe("PanelService", () => {
  test("ReportEvent is stored and delivered once per outbox id", async () => {
    const agent = await join();
    const seen: { outboxId: string | null; durable: boolean }[] = [];
    panel.deps.agents.onEvent("nodeAlert", (_nodeId, _alert, _event, meta) => seen.push(meta));
    const request = { outboxId: 42n, event: { payload: { case: "nodeAlert" as const, value: { message: "disk low" } } } };
    await agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, request);
    await agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, request);
    expect(seen).toEqual([{ outboxId: "42", durable: true }]);
    const rows = panel.deps.db.select().from(agentReports).where(eq(agentReports.nodeId, agent.nodeId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("nodeAlert");
  });

  test("ReportCrash is stored once and reaches onCrash", async () => {
    const agent = await join();
    const project = seedProject(panel);
    const service = seedService(panel, project.id, agent.nodeId);
    const crashes: string[] = [];
    panel.deps.agents.onCrash((_nodeId, report, meta) => crashes.push(`${report.serviceId}:${meta.outboxId}`));
    const request = { outboxId: 7n, report: { serviceId: service.id, exitCode: 137, oomKilled: true, streak: 2, lastLines: ["boom"] } };
    await agent.callPanel("ReportCrash", ReportCrashRequestSchema, ReportCrashResponseSchema, request);
    await agent.callPanel("ReportCrash", ReportCrashRequestSchema, ReportCrashResponseSchema, request);
    expect(crashes).toEqual([`${service.id}:7`]);
    const rows = panel.deps.db.select().from(crashReports).all();
    expect(rows).toMatchObject([{ serviceId: service.id, exitCode: 137, oomKilled: true, lastLines: ["boom"] }]);
  });

  test("GetDesiredState returns the state once, then nothing for a current revision", async () => {
    const agent = await join();
    const project = seedProject(panel);
    seedService(panel, project.id, agent.nodeId, { name: "web" });
    const first = await agent.callPanel("GetDesiredState", GetDesiredStateRequestSchema, GetDesiredStateResponseSchema, {
      knownRevision: 0n,
    });
    expect(first.state?.services.map((s) => s.name)).toEqual(["web"]);
    const again = await agent.callPanel("GetDesiredState", GetDesiredStateRequestSchema, GetDesiredStateResponseSchema, {
      knownRevision: first.state?.revision ?? 0n,
    });
    expect(again.state).toBeUndefined();
  });

  test("RegistryTunnel relays bytes to the registry through the panel node's Tunnel, scoped to the node", async () => {
    const panelNode = await join({ name: "panel-node" });
    let scope: { nodeId: string; pull: string[]; push: string[] } | undefined;
    panelNode.handleStream("Tunnel", async (request: { target: { case: string; value: { scope?: typeof scope } } }, stream) => {
      expect(request.target.case).toBe("registry");
      scope = request.target.value.scope;
      for (;;) {
        const chunk = await stream.read();
        if (!chunk) break;
        await stream.write(new TextEncoder().encode(new TextDecoder().decode(chunk).toUpperCase()));
      }
      return {};
    });
    const worker = await join({ name: "worker" });
    // A service on the worker is in its scope; one only on the panel node is not.
    const project = seedProject(panel);
    const mine = seedService(panel, project.id, worker.nodeId, { name: "mine" });
    const other = seedService(panel, project.id, panelNode.nodeId, { name: "other" });
    const tunnel = worker.openPanelRaw("RegistryTunnel");
    await tunnel.write(new TextEncoder().encode("get /v2/"));
    const reply = await tunnel.read();
    expect(new TextDecoder().decode(reply ?? new Uint8Array())).toBe("GET /V2/");
    tunnel.closeSend();
    const end = await tunnel.end;
    expect(end.status.code).toBe(StatusCode.OK);
    expect(scope?.nodeId).toBe(worker.nodeId);
    expect(scope?.pull).toContain(mine.id);
    expect(scope?.pull).not.toContain(other.id);
    expect(scope?.push).toEqual([]);
  });
});

describe("handshake policy", () => {
  test("agents older than the floor are refused with the minimum version; dev agents connect", async () => {
    panel.deps.agents.setAgentVersionPolicy(() => "1.4.0");
    const old = await join({ agentVersion: "1.2.9" });
    expect(old.rejected).toMatchObject({ reason: HelloRejectReason.AGENT_TOO_OLD, minAgentVersion: "1.4.0" });
    const rc = await join({ agentVersion: "1.4.0-rc.1" });
    expect(rc.rejected).toBeNull();
    const dev = await join({ agentVersion: "dev" });
    expect(dev.rejected).toBeNull();
  });
});

describe("desired state sync", () => {
  test("connect syncs everything; marks send ApplyService and RemoveService", async () => {
    const agent = await join();
    const project = seedProject(panel);
    const web = seedService(panel, project.id, agent.nodeId, { name: "web" });
    const flusher = flusherFor(panel.deps);
    if (!flusher) throw new Error("no flusher");

    panel.deps.agents.desired.markDirty({ serviceId: web.id });
    await panel.deps.agents.desired.settled();
    const applies = await agent.waitFor("ApplyService");
    expect(applies[0].service.name).toBe("web");
    expect(agent.desired.has(web.id)).toBe(true);

    // Moving it away removes it with its data (the move already copied the volumes).
    panel.deps.db.delete(servicePlacements).where(eq(servicePlacements.serviceId, web.id)).run();
    panel.deps.agents.desired.markDirty({ serviceId: web.id });
    await panel.deps.agents.desired.settled();
    const removes = await agent.waitFor("RemoveService");
    expect(removes[0]).toMatchObject({ serviceId: web.id, deleteData: true });

    // A reconnect gets the full state again with a higher revision.
    const before = agent.appliedRevision;
    seedService(panel, project.id, agent.nodeId, { name: "api" });
    await agent.close();
    const again = new (agent.constructor as typeof FakeAgent)({
      url,
      panelId: panel.deps.panelId,
      nodeId: agent.nodeId,
      key: agent.key,
      capabilities: ["state.sync.v1"],
    });
    agents.push(again);
    await again.connect();
    await flusher.flush();
    const syncs = await again.waitFor("SyncDesired");
    expect(syncs[0].state.services.map((s: { name: string }) => s.name)).toEqual(["api"]);
    expect(again.appliedRevision).toBeGreaterThan(before);
  });

  test("a node joined from another panel keeps the data of the services that panel ran there", async () => {
    // seylo join --force keeps the agent's desired state: the node reports the other panel's
    // services. The hub keeps only services placed on the node (service-scope.ts), so the connect
    // sync drops their containers (SyncDesired keeps data) and never purges them with their data.
    const theirs = "othr000000000001";
    const agent = new FakeAgent({ url, panelId: panel.deps.panelId, capabilities: allCapabilities, token: addJoinToken(panel) });
    agent.appliedRevision = 57n;
    agent.handle("GetStateSnapshot", () => ({
      snapshot: { epoch: 1n, seq: 0n, appliedRevision: 57n, services: [{ serviceId: theirs, generation: 3n }] },
    }));
    agents.push(agent);
    await agent.connect();
    await agent.waitFor("SyncDesired");
    await flusherFor(panel.deps)?.flush();
    await Bun.sleep(50);
    expect(agent.requests("SyncDesired").at(-1)).toMatchObject({ state: { services: [] } });
    expect(agent.requests("RemoveService").filter((r) => (r as { deleteData: boolean }).deleteData)).toEqual([]);

    // A service this panel ran there and deleted still goes with its data.
    const project = seedProject(panel);
    const web = seedService(panel, project.id, agent.nodeId, { name: "web" });
    panel.deps.agents.desired.markDirty({ serviceId: web.id });
    await panel.deps.agents.desired.settled();
    await agent.waitFor("ApplyService");
    panel.deps.db.delete(services).where(eq(services.id, web.id)).run();
    panel.deps.agents.desired.markDirty({ serviceId: web.id });
    await panel.deps.agents.desired.settled();
    expect((await agent.waitFor("RemoveService")).map((r) => r as { serviceId: string; deleteData: boolean })).toEqual([
      expect.objectContaining({ serviceId: web.id, deleteData: true }),
    ]);
  });

  test("a deleted service is removed with its data", async () => {
    const agent = await join();
    const project = seedProject(panel);
    const web = seedService(panel, project.id, agent.nodeId, { name: "web" });
    panel.deps.agents.desired.markDirty({ serviceId: web.id });
    await panel.deps.agents.desired.settled();
    await agent.waitFor("ApplyService");
    panel.deps.db.delete(services).where(eq(services.id, web.id)).run();
    panel.deps.agents.desired.markDirty({ serviceId: web.id });
    await panel.deps.agents.desired.settled();
    expect((await agent.waitFor("RemoveService"))[0]).toMatchObject({ serviceId: web.id, deleteData: true });
  });
});
