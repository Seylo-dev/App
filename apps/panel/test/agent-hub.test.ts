import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { slug } from "@seylo/brand";
import { OpError } from "@seylo/ops";
import {
  CallSchema,
  ClientHelloSchema,
  CloseSchema,
  CONNECTION_STREAM,
  encodeFrame,
  FrameKind,
  FsListResponseSchema,
  GetStateSnapshotResponseSchema,
  HandshakeSchema,
  HelloRejectReason,
  NodeFactsSchema,
  parseFrame,
  ResultSchema,
  StatusCode,
  SyncDesiredRequestSchema,
  SyncDesiredResponseSchema,
} from "@seylo/proto";
import { eq } from "drizzle-orm";
import { agentConnectPath, agentSubprotocol } from "../src/agent-hub/endpoint";
import { decideHello } from "../src/agent-hub/handshake";
import { helloSignedBytes } from "../src/agent-hub/signature";
import { joinTokens, nodes, projects, servicePlacements, services, users } from "../src/db/schema";
import { flusherFor } from "../src/modules/nodes/index";
import { importInstallerJoinToken, installerJoinTokenFile } from "../src/modules/nodes/installer-join";
import { hashToken } from "../src/security/tokens";
import { getSetting } from "../src/settings";
import { type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(async () => {
  if (panel.app.server) await panel.app.stop(true);
  panel.close();
});

function agentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: new Uint8Array(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url")) };
}

/** A join token as Add node stores it; canBuild left out is the column default (off), as before 0.2.1. */
function addJoinToken(token: string, expiresInMs = 3_600_000, options: { canBuild?: boolean } = {}) {
  panel.deps.db
    .insert(joinTokens)
    .values({ tokenHash: hashToken(token), expiresAt: new Date(Date.now() + expiresInMs), canBuild: options.canBuild })
    .run();
}

function joinHello(nonce: Uint8Array, token: string, key: { privateKey: KeyObject; publicKey: Uint8Array }, name = "edge-1") {
  const signature = sign(null, helloSignedBytes(panel.deps.panelId, "", nonce), key.privateKey);
  return create(ClientHelloSchema, {
    agentVersion: "1.0.0",
    facts: { hostname: "host-a", arch: "arm64" },
    credential: { case: "join", value: { token, publicKey: key.publicKey, signature, requestedName: name } },
  });
}

function resumeHello(nonce: Uint8Array, nodeId: string, privateKey: KeyObject) {
  const signature = sign(null, helloSignedBytes(panel.deps.panelId, nodeId, nonce), privateKey);
  return create(ClientHelloSchema, { agentVersion: "1.0.1", credential: { case: "resume", value: { nodeId, signature } } });
}

describe("decideHello: re-join, panel node, NAT address", () => {
  const nonce = crypto.getRandomValues(new Uint8Array(32));

  test("a valid token with a known key re-joins that node instead of failing", () => {
    const key = agentKey();
    addJoinToken("first");
    const joined = decideHello(panel.deps.db, panel.deps.panelId, nonce, joinHello(nonce, "first", key));
    addJoinToken("again");
    const rejoined = decideHello(panel.deps.db, panel.deps.panelId, nonce, joinHello(nonce, "again", key));
    expect(joined).toMatchObject({ ok: true, joined: true });
    expect(rejoined).toMatchObject({ ok: true, joined: false, nodeId: (joined as { nodeId: string }).nodeId });
  });

  test("on an installer-managed panel only the installer's token makes the panel node", () => {
    addJoinToken("remote");
    // Tokens from Add node carry their creator; the installer's has none.
    panel.deps.db.update(joinTokens).set({ createdBy: null }).run();
    const owner = panel.deps.db.insert(users).values({ email: "o@example.com", name: "o", role: "owner" }).returning().get();
    panel.deps.db
      .update(joinTokens)
      .set({ createdBy: owner.id })
      .where(eq(joinTokens.tokenHash, hashToken("remote")))
      .run();
    const remote = decideHello(panel.deps.db, panel.deps.panelId, nonce, joinHello(nonce, "remote", agentKey(), "remote"), {
      panelNodeFromInstallerOnly: true,
      remoteIp: "93.184.216.20",
    });
    const row = panel.deps.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, (remote as { nodeId: string }).nodeId))
      .get();
    expect(row?.isPanelNode).toBe(false);
    // Facts had no public address (1:1 NAT): the address it connected from stands in.
    expect(row?.publicIpv4).toBe("93.184.216.20");
    addJoinToken("installer");
    const local = decideHello(panel.deps.db, panel.deps.panelId, nonce, joinHello(nonce, "installer", agentKey(), "local"), {
      panelNodeFromInstallerOnly: true,
      remoteIp: "10.0.0.5",
    });
    const localRow = panel.deps.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, (local as { nodeId: string }).nodeId))
      .get();
    expect(localRow?.isPanelNode).toBe(true);
    expect(localRow?.publicIpv4).toBeNull();
  });

  test("the panel keeps the public address a node connected from, apart from what its facts claim", () => {
    // Git sources count it among the node's trusted addresses; public_ipv4 is the agent's word first.
    const key = agentKey();
    addJoinToken("seen");
    const hello = joinHello(nonce, "seen", key);
    hello.facts = create(NodeFactsSchema, { hostname: "host-a", publicIpv4: "140.82.121.4" });
    const joined = decideHello(panel.deps.db, panel.deps.panelId, nonce, hello, { remoteIp: "93.184.216.20" });
    const nodeId = (joined as { nodeId: string }).nodeId;
    expect(panel.deps.db.select().from(nodes).where(eq(nodes.id, nodeId)).get()?.publicIpv4).toBe("140.82.121.4");
    expect(getSetting(panel.deps.db, "nodeConnectAddresses")).toEqual({ [nodeId]: "93.184.216.20" });
    // Back over a private network: no public connect address any more.
    expect(
      decideHello(panel.deps.db, panel.deps.panelId, nonce, resumeHello(nonce, nodeId, key.privateKey), { remoteIp: "10.0.0.5" }),
    ).toMatchObject({
      ok: true,
    });
    expect(getSetting(panel.deps.db, "nodeConnectAddresses")).toEqual({});
    decideHello(panel.deps.db, panel.deps.panelId, nonce, resumeHello(nonce, nodeId, key.privateKey), { remoteIp: "2a01:4f8::9" });
    expect(getSetting(panel.deps.db, "nodeConnectAddresses")).toEqual({ [nodeId]: "2a01:4f8::9" });
  });

  test("a resume without facts (seylo set-panel's check) keeps the node's facts and public addresses", () => {
    // compile.ts reads privateIpv4 from the row for other nodes' LB peers; a wiped row moves them.
    const key = agentKey();
    addJoinToken("facts");
    const hello = joinHello(nonce, "facts", key);
    hello.facts = create(NodeFactsSchema, {
      hostname: "host-a",
      publicIpv4: "140.82.121.4",
      publicIpv6: "2a01:4f8::1",
      privateIpv4: "10.0.0.7",
      interfaceAddresses: ["10.0.0.7", "140.82.121.4"],
    });
    const nodeId = (decideHello(panel.deps.db, panel.deps.panelId, nonce, hello, { remoteIp: "140.82.121.4" }) as { nodeId: string })
      .nodeId;
    const row = () => panel.deps.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
    const before = row();
    expect(before?.facts).toMatchObject({ privateIpv4: "10.0.0.7" });

    // Over the panel's IP from another address of the node.
    const check = decideHello(panel.deps.db, panel.deps.panelId, nonce, resumeHello(nonce, nodeId, key.privateKey), {
      remoteIp: "93.184.216.20",
    });
    expect(check).toMatchObject({ ok: true, joined: false });
    const after = row();
    expect(after?.facts).toEqual(before?.facts as Record<string, unknown>);
    expect(after?.publicIpv4).toBe("140.82.121.4");
    expect(after?.publicIpv6).toBe("2a01:4f8::1");
    expect(after?.agentVersion).toBe("1.0.1");
    // The address it connected from is the panel's own observation, kept as on every handshake.
    expect(getSetting(panel.deps.db, "nodeConnectAddresses")).toEqual({ [nodeId]: "93.184.216.20" });

    // The agent's own connect (facts again) replaces them.
    const resumed = resumeHello(nonce, nodeId, key.privateKey);
    resumed.facts = create(NodeFactsSchema, { hostname: "host-a", privateIpv4: "10.0.0.8" });
    decideHello(panel.deps.db, panel.deps.panelId, nonce, resumed, { remoteIp: "93.184.216.20" });
    expect(row()?.facts).toMatchObject({ privateIpv4: "10.0.0.8" });
    expect(row()?.publicIpv4).toBe("93.184.216.20");
    expect(row()?.publicIpv6).toBeNull();
  });

  test("a join without facts still records the public address it connected from", () => {
    addJoinToken("bare");
    const hello = joinHello(nonce, "bare", agentKey());
    hello.facts = undefined;
    const joined = decideHello(panel.deps.db, panel.deps.panelId, nonce, hello, { remoteIp: "93.184.216.20" });
    const row = panel.deps.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, (joined as { nodeId: string }).nodeId))
      .get();
    expect(row?.facts).toBeNull();
    expect(row?.publicIpv4).toBe("93.184.216.20");
  });
});

describe("decideHello", () => {
  const nonce = crypto.getRandomValues(new Uint8Array(32));

  describe("Can build comes from the join token, never from the node", () => {
    const hello = (token: string, name: string, factsCanBuild: boolean, key = agentKey()) => {
      const h = joinHello(nonce, token, key, name);
      if (h.facts) h.facts.canBuild = factsCanBuild;
      return h;
    };
    const row = (decision: ReturnType<typeof decideHello>) =>
      panel.deps.db
        .select()
        .from(nodes)
        .where(eq(nodes.id, (decision as { nodeId: string }).nodeId))
        .get();

    test("a token with Can build on gives a builder, although the node's config.yml says no", () => {
      addJoinToken("first", 3_600_000, { canBuild: true });
      expect(row(decideHello(panel.deps.db, panel.deps.panelId, nonce, hello("first", "panel", false)))).toMatchObject({
        isPanelNode: true,
        canBuild: true,
      });
      addJoinToken("on", 3_600_000, { canBuild: true });
      expect(row(decideHello(panel.deps.db, panel.deps.panelId, nonce, hello("on", "worker", false)))).toMatchObject({
        isPanelNode: false,
        canBuild: true,
      });
    });

    test("a token with Can build off gives a non-builder, although the node asks (seylo join --can-build)", () => {
      // Before 0.2: facts.canBuild decided, so any machine could pull other projects' builds (source, git tokens, build secrets).
      addJoinToken("first");
      decideHello(panel.deps.db, panel.deps.panelId, nonce, hello("first", "panel", true));
      addJoinToken("off", 3_600_000, { canBuild: false });
      expect(row(decideHello(panel.deps.db, panel.deps.panelId, nonce, hello("off", "worker", true)))).toMatchObject({
        isPanelNode: false,
        canBuild: false,
      });
    });

    test("the installer's token makes a building panel node", () => {
      const dir = mkdtempSync(join(tmpdir(), "hub-installer-"));
      try {
        const token = `${slug}_join_${"b".repeat(43)}`;
        writeFileSync(join(dir, installerJoinTokenFile), `${token}\n`);
        expect(importInstallerJoinToken(panel.deps.db, dir, panel.deps.logger)).toBe(true);
        const local = decideHello(panel.deps.db, panel.deps.panelId, nonce, hello(token, "local", false), {
          panelNodeFromInstallerOnly: true,
        });
        expect(row(local)).toMatchObject({ isPanelNode: true, canBuild: true });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a re-join keeps the node's own value, both ways", () => {
      // Master-key rotation and install.sh --force re-join with a fresh token: the owner's choice under Nodes stays.
      const builder = agentKey();
      const worker = agentKey();
      addJoinToken("builder", 3_600_000, { canBuild: true });
      const b = decideHello(panel.deps.db, panel.deps.panelId, nonce, hello("builder", "builder", false, builder));
      addJoinToken("worker", 3_600_000, { canBuild: false });
      const w = decideHello(panel.deps.db, panel.deps.panelId, nonce, hello("worker", "worker", true, worker));
      expect([row(b)?.canBuild, row(w)?.canBuild]).toEqual([true, false]);

      addJoinToken("builder-again", 3_600_000, { canBuild: false });
      const b2 = decideHello(panel.deps.db, panel.deps.panelId, nonce, hello("builder-again", "builder", false, builder));
      addJoinToken("worker-again", 3_600_000, { canBuild: true });
      const w2 = decideHello(panel.deps.db, panel.deps.panelId, nonce, hello("worker-again", "worker", true, worker));
      expect(b2).toMatchObject({ ok: true, joined: false, nodeId: (b as { nodeId: string }).nodeId });
      expect(w2).toMatchObject({ ok: true, joined: false, nodeId: (w as { nodeId: string }).nodeId });
      expect([row(b2)?.canBuild, row(w2)?.canBuild]).toEqual([true, false]);
    });
  });

  test("a valid join creates the node and consumes the token", () => {
    const key = agentKey();
    addJoinToken("tok");
    const decision = decideHello(panel.deps.db, panel.deps.panelId, nonce, joinHello(nonce, "tok", key));
    expect(decision).toMatchObject({ ok: true, joined: true });
    if (!decision.ok) return;

    const node = panel.deps.db.select().from(nodes).where(eq(nodes.id, decision.nodeId)).get();
    expect(node).toMatchObject({ name: "edge-1", agentVersion: "1.0.0" });
    const again = decideHello(panel.deps.db, panel.deps.panelId, nonce, joinHello(nonce, "tok", agentKey()));
    expect(again).toMatchObject({ ok: false, reason: HelloRejectReason.INVALID_TOKEN });
  });

  test("expired tokens and bad signatures are rejected", () => {
    addJoinToken("old", -1);
    expect(decideHello(panel.deps.db, panel.deps.panelId, nonce, joinHello(nonce, "old", agentKey()))).toMatchObject({
      ok: false,
      reason: HelloRejectReason.TOKEN_EXPIRED,
    });

    addJoinToken("tok");
    const otherNonce = crypto.getRandomValues(new Uint8Array(32));
    expect(decideHello(panel.deps.db, panel.deps.panelId, nonce, joinHello(otherNonce, "tok", agentKey()))).toMatchObject({
      ok: false,
      reason: HelloRejectReason.BAD_SIGNATURE,
    });
  });

  test("resume needs the key the node joined with", () => {
    const key = agentKey();
    addJoinToken("tok");
    const joined = decideHello(panel.deps.db, panel.deps.panelId, nonce, joinHello(nonce, "tok", key));
    if (!joined.ok) throw new Error("join failed");

    expect(decideHello(panel.deps.db, panel.deps.panelId, nonce, resumeHello(nonce, joined.nodeId, key.privateKey))).toMatchObject({
      ok: true,
      joined: false,
    });
    expect(decideHello(panel.deps.db, panel.deps.panelId, nonce, resumeHello(nonce, joined.nodeId, agentKey().privateKey))).toMatchObject({
      ok: false,
      reason: HelloRejectReason.BAD_SIGNATURE,
    });
    expect(decideHello(panel.deps.db, panel.deps.panelId, nonce, resumeHello(nonce, "nonexistent00000", key.privateKey))).toMatchObject({
      ok: false,
      reason: HelloRejectReason.UNKNOWN_NODE,
    });
  });

  test("two hosts asking for the same name get distinct names", () => {
    addJoinToken("a");
    addJoinToken("b");
    decideHello(panel.deps.db, panel.deps.panelId, nonce, joinHello(nonce, "a", agentKey(), "web"));
    decideHello(panel.deps.db, panel.deps.panelId, nonce, joinHello(nonce, "b", agentKey(), "web"));
    expect(
      panel.deps.db
        .select({ name: nodes.name })
        .from(nodes)
        .all()
        .map((n) => n.name)
        .sort(),
    ).toEqual(["web", "web-2"]);
  });
});

/** A minimal agent over a real WebSocket: collects frames and lets the test send. */
async function connectAgent(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${agentConnectPath}`, [agentSubprotocol]);
  ws.binaryType = "arraybuffer";
  const frames: ReturnType<typeof parseFrame>[] = [];
  const waiters: (() => void)[] = [];
  let closeCode: number | undefined;
  ws.onmessage = (event) => {
    frames.push(parseFrame(new Uint8Array(event.data as ArrayBuffer)));
    for (const wake of waiters.splice(0)) wake();
  };
  ws.onclose = (event) => {
    closeCode = event.code;
    for (const wake of waiters.splice(0)) wake();
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const next = async () => {
    while (frames.length === 0 && closeCode === undefined) await new Promise<void>((wake) => waiters.push(wake));
    const frame = frames.shift();
    if (!frame) throw new Error(`socket closed with ${closeCode}`);
    return frame;
  };
  const sendHandshake = (hello: ReturnType<typeof joinHello>) =>
    ws.send(
      encodeFrame({
        kind: FrameKind.EVENT,
        stream: CONNECTION_STREAM,
        payload: toBinary(HandshakeSchema, create(HandshakeSchema, { step: { case: "clientHello", value: hello } })),
      }),
    );
  return { ws, next, sendHandshake, closeCode: () => closeCode };
}

describe("agent WebSocket", () => {
  test("handshake, then agent calls reach PanelService", async () => {
    panel.app.listen({ hostname: "127.0.0.1", port: 0 });
    const port = panel.app.server!.port as number;
    const agent = await connectAgent(port);
    expect(agent.ws.protocol).toBe(agentSubprotocol);

    const serverHello = fromBinary(HandshakeSchema, (await agent.next()).payload);
    expect(serverHello.step.case).toBe("serverHello");
    if (serverHello.step.case !== "serverHello") return;
    expect(serverHello.step.value.panelId).toBe(panel.deps.panelId);

    addJoinToken("tok");
    agent.sendHandshake(joinHello(serverHello.step.value.nonce, "tok", agentKey()));
    const accepted = fromBinary(HandshakeSchema, (await agent.next()).payload);
    expect(accepted.step.case).toBe("accepted");
    if (accepted.step.case !== "accepted") return;
    expect(accepted.step.value.edgeTicketPublicKey).toHaveLength(32);
    expect(panel.deps.agents.isOnline(accepted.step.value.nodeId)).toBe(true);

    const call = create(CallSchema, { method: "/seylo.agent.v1.PanelService/ReportCrash" });
    agent.ws.send(encodeFrame({ kind: FrameKind.CALL, stream: 1, payload: toBinary(CallSchema, call) }));
    const resultFrame = await agent.next();
    expect(resultFrame).toMatchObject({ kind: FrameKind.RESULT, stream: 1 });
    // An empty ReportCrash is refused by the handler (no report), which proves it ran.
    expect(fromBinary(ResultSchema, resultFrame.payload).status?.code).toBe(StatusCode.INVALID_ARGUMENT);

    const nodeId = accepted.step.value.nodeId;
    const disconnected = new Promise<void>((resolve) => {
      const off = panel.deps.agents.onConnection((id, online) => {
        if (id !== nodeId || online) return;
        off();
        resolve();
      });
    });
    agent.ws.close();
    await disconnected;
    expect(panel.deps.agents.isOnline(nodeId)).toBe(false);
  });

  test("a rejected agent gets the reason and the socket closes", async () => {
    panel.app.listen({ hostname: "127.0.0.1", port: 0 });
    const agent = await connectAgent(panel.app.server!.port as number);
    const serverHello = fromBinary(HandshakeSchema, (await agent.next()).payload);
    if (serverHello.step.case !== "serverHello") throw new Error("expected ServerHello");

    agent.sendHandshake(joinHello(serverHello.step.value.nonce, "no-such-token", agentKey()));
    const rejected = fromBinary(HandshakeSchema, (await agent.next()).payload);
    expect(rejected.step).toMatchObject({ case: "rejected", value: { reason: HelloRejectReason.INVALID_TOKEN } });
    // The panel closes with 1008. Bun's WebSocket client sometimes reports
    // 1006 for a close that follows a message this closely, so only the
    // close itself is asserted.
    await expect(agent.next()).rejects.toThrow(/socket closed/);
  });

  test("clients without the agent subprotocol are refused", async () => {
    const response = await panel.app.handle(
      new Request(`http://panel.test${agentConnectPath}`, { headers: { upgrade: "websocket", connection: "upgrade" } }),
    );
    expect(response.status).toBe(400);
  });
});

describe("panel -> agent calls", () => {
  /** Joins an agent that advertises the given capabilities and returns it with its node id. */
  async function joinedAgent(capabilities: string[]) {
    panel.app.listen({ hostname: "127.0.0.1", port: 0 });
    const agent = await connectAgent(panel.app.server!.port as number);
    const serverHello = fromBinary(HandshakeSchema, (await agent.next()).payload);
    if (serverHello.step.case !== "serverHello") throw new Error("expected ServerHello");
    addJoinToken("tok-calls");
    const hello = joinHello(serverHello.step.value.nonce, "tok-calls", agentKey());
    hello.facts = create(NodeFactsSchema, { hostname: "host-a", capabilities });
    agent.sendHandshake(hello);
    const accepted = fromBinary(HandshakeSchema, (await agent.next()).payload);
    if (accepted.step.case !== "accepted") throw new Error("expected accepted");
    return { agent, nodeId: accepted.step.value.nodeId };
  }

  const reply = (
    agent: Awaited<ReturnType<typeof connectAgent>>,
    stream: number,
    result: Parameters<typeof create<typeof ResultSchema>>[1],
  ) => agent.ws.send(encodeFrame({ kind: FrameKind.RESULT, stream, payload: toBinary(ResultSchema, create(ResultSchema, result)) }));

  test("a connect fetches the snapshot, then typed calls round-trip", async () => {
    const { agent, nodeId } = await joinedAgent(["state.sync.v1", "fs.basic.v1"]);
    expect([...(panel.deps.agents.capabilities(nodeId) ?? [])]).toEqual(["state.sync.v1", "fs.basic.v1"]);

    // The hub asks for the actual state right after the handshake.
    const snapshotCall = await agent.next();
    expect(snapshotCall).toMatchObject({ kind: FrameKind.CALL, stream: 2 });
    expect(fromBinary(CallSchema, snapshotCall.payload).method).toBe("/seylo.agent.v1.AgentService/GetStateSnapshot");
    // svc..1 runs on this node; svc..2 does not, so what the node says about it is dropped.
    const project = panel.deps.db.insert(projects).values({ name: "p", nameKey: "p" }).returning().get();
    for (const id of ["svc0000000000001", "svc0000000000002"]) {
      panel.deps.db.insert(services).values({ id, projectId: project.id, name: id, nameKey: id, kind: "app", spec: {} }).run();
    }
    panel.deps.db.insert(servicePlacements).values({ serviceId: "svc0000000000001", nodeId }).run();
    const snapshot = create(GetStateSnapshotResponseSchema, {
      snapshot: {
        epoch: 7n,
        seq: 3n,
        appliedRevision: 5n,
        services: [
          { serviceId: "svc0000000000001", generation: 2n },
          { serviceId: "svc0000000000002", generation: 1n },
        ],
      },
    });
    const applied = new Promise<void>((resolve) => {
      const off = panel.deps.agents.state.onChange((id, change) => {
        if (id !== nodeId || change.kind !== "snapshot") return;
        off();
        resolve();
      });
    });
    reply(agent, 2, { status: { code: StatusCode.OK }, response: toBinary(GetStateSnapshotResponseSchema, snapshot) });
    await applied;
    const view = panel.deps.agents.state.get(nodeId);
    expect(view?.synced).toBe(true);
    expect(view?.appliedRevision).toBe(5n);
    expect(panel.deps.agents.state.serviceStatuses("svc0000000000001")).toHaveLength(1);
    expect(panel.deps.agents.state.serviceStatuses("svc0000000000002")).toHaveLength(0);

    // The snapshot is what the node's connect sync waits for (desired/flusher.ts). It
    // would go out after the flusher's debounce, in the middle of the calls below on a
    // slow machine; run it now and answer it, so this test owns every stream after it.
    const connectSync = flusherFor(panel.deps)?.flush();
    const syncFrame = await agent.next();
    expect(syncFrame).toMatchObject({ kind: FrameKind.CALL, stream: 4 });
    const sync = fromBinary(CallSchema, syncFrame.payload);
    expect(sync.method).toBe("/seylo.agent.v1.AgentService/SyncDesired");
    // The node's revision jumps past the one the agent reported as applied.
    const revision = fromBinary(SyncDesiredRequestSchema, sync.request).state?.revision ?? 0n;
    expect(revision).toBeGreaterThan(5n);
    const accepted = create(SyncDesiredResponseSchema, { acceptedRevision: revision });
    reply(agent, 4, { status: { code: StatusCode.OK }, response: toBinary(SyncDesiredResponseSchema, accepted) });
    await connectSync;

    const pending = panel.deps.agents.call(nodeId, "fsList", { root: { serviceId: "svc0000000000001", volume: "data" }, path: "/" });
    const callFrame = await agent.next();
    expect(callFrame).toMatchObject({ kind: FrameKind.CALL, stream: 6 });
    const call = fromBinary(CallSchema, callFrame.payload);
    expect(call.method).toBe("/seylo.agent.v1.AgentService/FsList");
    expect(call.deadline).toBeDefined();
    // The relative timeout is stamped from the same clock reading as the deadline.
    expect(call.timeout).toBeDefined();
    const deadlineMs = Number(call.deadline?.seconds ?? 0n) * 1000 + Math.floor((call.deadline?.nanos ?? 0) / 1e6);
    const timeoutMs = Number(call.timeout?.seconds ?? 0n) * 1000 + Math.floor((call.timeout?.nanos ?? 0) / 1e6);
    expect(Math.abs(deadlineMs - timeoutMs - Date.now())).toBeLessThan(5_000);
    const listing = create(FsListResponseSchema, { entries: [{ name: "a.txt", path: "a.txt", size: 3n }] });
    reply(agent, 6, { status: { code: StatusCode.OK }, response: toBinary(FsListResponseSchema, listing) });
    expect((await pending).entries[0]?.name).toBe("a.txt");

    // An error status becomes the matching OpError with the agent's message.
    const missing = panel.deps.agents.call(nodeId, "fsStat", { root: { serviceId: "svc0000000000001", volume: "data" }, path: "x" });
    const statFrame = await agent.next();
    expect(statFrame).toMatchObject({ kind: FrameKind.CALL, stream: 8 });
    expect(fromBinary(CallSchema, statFrame.payload).method).toBe("/seylo.agent.v1.AgentService/FsStat");
    reply(agent, statFrame.stream, { status: { code: StatusCode.NOT_FOUND, message: "no such file" } });
    await expect(missing).rejects.toMatchObject({ code: "NOT_FOUND", message: "no such file", details: { reason: "agent" } });
    agent.ws.close();
  });

  test("timeouts cancel the call on the agent; offline and old agents fail clearly", async () => {
    const { agent, nodeId } = await joinedAgent(["fs.basic.v1"]);
    const slow = panel.deps.agents.call(nodeId, "fsMkdir", { path: "a" }, { timeoutMs: 30 });
    expect((await agent.next()).kind).toBe(FrameKind.CALL);
    await expect(slow).rejects.toMatchObject({ code: "UNAVAILABLE", details: { reason: "timeout" } });
    const cancel = await agent.next();
    expect(cancel.kind).toBe(FrameKind.CLOSE);
    expect(fromBinary(CloseSchema, cancel.payload).status?.code).toBe(StatusCode.CANCELLED);
    // A late RESULT for the cancelled call is ignored, not a protocol error.
    reply(agent, cancel.stream, { status: { code: StatusCode.OK } });

    await expect(panel.deps.agents.call(nodeId, "reboot", {})).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      details: { reason: "capability", capability: "node.reboot.v1" },
    });

    const inFlight = panel.deps.agents.call(nodeId, "fsMkdir", { path: "b" });
    await agent.next();
    agent.ws.close();
    await expect(inFlight).rejects.toMatchObject({ code: "UNAVAILABLE", details: { reason: "offline" } });
    // The session leaves the hub before it fails its calls, so the node is offline by now.
    expect(panel.deps.agents.isOnline(nodeId)).toBe(false);
    const offline = panel.deps.agents.call(nodeId, "fsMkdir", { path: "c" });
    await expect(offline).rejects.toBeInstanceOf(OpError);
    await expect(offline).rejects.toMatchObject({ details: { reason: "offline" } });
    expect(panel.deps.agents.capabilities(nodeId)).toBeNull();
  });
});
