// Bun drops a WebSocket message once the socket buffers more than its
// backpressure limit (send returns 0) and leaves the socket open. The
// writer must not go on as if the frame went out: the first drop closes
// the writer, and the session closes the connection so the agent
// reconnects and both sides resync.

import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { CONNECTION_STREAM, encodeFrame, FrameKind, HandshakeSchema, parseFrame } from "@seylo/proto";
import { AgentSession } from "../src/agent-hub/session";
import { helloSignedBytes } from "../src/agent-hub/signature";
import { FrameWriter } from "../src/agent-hub/writer";
import { silentLogger } from "../src/logger";
import { agentKey, allCapabilities } from "./fake-agent";
import { testPanel } from "./helpers";
import { addJoinToken } from "./hub-helpers";

test("the first dropped frame closes the writer and reports it once; nothing is written after it", () => {
  const sent: Uint8Array[] = [];
  let status = 100;
  let drops = 0;
  const writer = new FrameWriter(
    {
      send: (bytes) => {
        sent.push(bytes);
        return status;
      },
    },
    () => drops++,
  );
  writer.control({ kind: FrameKind.WINDOW, stream: 2, payload: new Uint8Array(4) });
  status = -1; // buffered under backpressure: still fine
  writer.control({ kind: FrameKind.WINDOW, stream: 2, payload: new Uint8Array(4) });
  status = 0; // dropped
  writer.control({ kind: FrameKind.CLOSE, stream: 2, payload: new Uint8Array() });
  writer.control({ kind: FrameKind.CLOSE, stream: 4, payload: new Uint8Array() });
  writer.data(6, new Uint8Array(10));
  expect(drops).toBe(1);
  expect(sent).toHaveLength(3);
});

test("a DATA frame the socket drops stops the round-robin too", () => {
  let drops = 0;
  let calls = 0;
  const writer = new FrameWriter({ send: () => (++calls >= 2 ? 0 : 100) }, () => drops++);
  for (let i = 0; i < 5; i++) writer.data(2 + 2 * i, new Uint8Array(10));
  expect(calls).toBe(2);
  expect(drops).toBe(1);
});

test("a session whose socket drops a frame closes the connection with 1011 and leaves the hub", async () => {
  const panel = testPanel();
  try {
    const frames: Uint8Array[] = [];
    let dropping = false;
    const closes: { code: number; reason: string }[] = [];
    const session = new AgentSession(
      {
        send: (bytes) => {
          if (dropping) return 0;
          frames.push(bytes);
          return bytes.length;
        },
        close: (code, reason) => closes.push({ code, reason }),
      },
      {
        db: panel.deps.db,
        hub: panel.deps.agents,
        logger: silentLogger(),
        panelId: panel.deps.panelId,
        panelVersion: "dev",
        edgeTicketKey: { publicKey: new Uint8Array(32), privateKey: generateKeyPairSync("ed25519").privateKey },
      },
    );
    session.start();
    const serverHello = fromBinary(HandshakeSchema, parseFrame(frames[0] as Uint8Array).payload);
    if (serverHello.step.case !== "serverHello") throw new Error("expected ServerHello");
    const key = agentKey();
    const signature = new Uint8Array(sign(null, helloSignedBytes(panel.deps.panelId, "", serverHello.step.value.nonce), key.privateKey));
    const hello = create(HandshakeSchema, {
      step: {
        case: "clientHello",
        value: {
          agentVersion: "dev",
          facts: { hostname: "stalled", capabilities: allCapabilities },
          credential: { case: "join", value: { token: addJoinToken(panel), publicKey: key.publicKey, signature, requestedName: "" } },
        },
      },
    });
    session.receive(encodeFrame({ kind: FrameKind.EVENT, stream: CONNECTION_STREAM, payload: toBinary(HandshakeSchema, hello) }));
    expect(panel.deps.agents.isOnline(session.nodeId)).toBe(true);

    // The agent stops reading; Bun starts dropping. Before: the call's CALL frame vanished and the socket stayed open.
    dropping = true;
    const call = panel.deps.agents.call(session.nodeId, "getNodeFacts", {}).catch((error: Error) => error);
    await Bun.sleep(10);
    expect(closes).toEqual([{ code: 1011, reason: "the agent stopped reading" }]);
    expect(panel.deps.agents.isOnline(session.nodeId)).toBe(false);
    expect(await call).toBeInstanceOf(Error);
  } finally {
    panel.close();
  }
});
