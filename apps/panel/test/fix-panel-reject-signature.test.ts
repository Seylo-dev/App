// HelloRejected.panel_signature: a rejection arrives before a node checks
// who it reached, so the panel signs it with its identity key; a host with
// a certificate for the panel's domain then cannot keep a node away from
// its panel or make it update itself. The bytes and the signature match the
// Go agent's reference vector (go/internal/rpc/accept_test.go).

import { expect, test } from "bun:test";
import { createPrivateKey, sign } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { CONNECTION_STREAM, encodeFrame, FrameKind, HandshakeSchema, HelloRejectReason, parseFrame } from "@seylo/proto";
import { AgentSession } from "../src/agent-hub/session";
import { helloSignedBytes, rejectSignedBytes, signReject, verifyEd25519 } from "../src/agent-hub/signature";
import { silentLogger } from "../src/logger";
import { ensureEdgeTicketKey } from "../src/security/edge-ticket-key";
import { agentKey, allCapabilities } from "./fake-agent";
import { testPanel } from "./helpers";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("the signed bytes and the signature match the agent's reference vector", () => {
  const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const fields = {
    panelId: "panel1",
    nonce: new Uint8Array(32).fill(0x5a),
    clientSignature: new Uint8Array(64).fill(0xa5),
    reason: HelloRejectReason.AGENT_TOO_OLD,
    minAgentVersion: "0.2.0",
  };
  expect(hex(rejectSignedBytes(fields))).toBe(
    `7365796c6f2d70616e656c2d72656a6563742d7631` +
      `0070616e656c31` +
      `00${"5a".repeat(32)}` +
      `00${"a5".repeat(64)}` +
      `0035` +
      `00302e322e30`,
  );
  expect(hex(signReject(key, fields))).toBe(
    "6df46e1e0d9401d70b16fa32b4369b2748f72832659e168a5134c216e4ddfbe4cbc8935f6b638166ec724e0209f22e4bf31a3eb4837275d3eaf5f6042002a905",
  );
});

test("a rejected hello carries a signature over this connection that the identity key verifies", () => {
  const panel = testPanel();
  try {
    const edgeKey = ensureEdgeTicketKey(panel.deps.db, panel.deps.secrets);
    const frames: Uint8Array[] = [];
    const session = new AgentSession(
      {
        send: (bytes) => {
          frames.push(bytes);
          return bytes.length;
        },
        close() {},
      },
      {
        db: panel.deps.db,
        hub: panel.deps.agents,
        logger: silentLogger(),
        panelId: panel.deps.panelId,
        panelVersion: "dev",
        edgeTicketKey: edgeKey,
      },
    );
    session.start();
    const server = fromBinary(HandshakeSchema, parseFrame(frames[0] as Uint8Array).payload);
    if (server.step.case !== "serverHello") throw new Error("expected ServerHello");
    const nonce = server.step.value.nonce;
    const key = agentKey();
    // A node this panel does not know.
    const clientSignature = new Uint8Array(sign(null, helloSignedBytes(panel.deps.panelId, "node0000000000001", nonce), key.privateKey));
    const hello = create(HandshakeSchema, {
      step: {
        case: "clientHello",
        value: {
          agentVersion: "dev",
          facts: { hostname: "n", capabilities: allCapabilities },
          credential: { case: "resume", value: { nodeId: "node0000000000001", signature: clientSignature } },
        },
      },
    });
    session.receive(encodeFrame({ kind: FrameKind.EVENT, stream: CONNECTION_STREAM, payload: toBinary(HandshakeSchema, hello) }));
    const rejected = frames.map((f) => fromBinary(HandshakeSchema, parseFrame(f).payload)).find((h) => h.step.case === "rejected");
    if (rejected?.step.case !== "rejected") throw new Error("expected HelloRejected");
    const r = rejected.step.value;
    expect(r.reason).toBe(HelloRejectReason.UNKNOWN_NODE);
    // Before: no panel_signature, so anyone answering at the panel's domain could send this.
    expect(r.panelSignature).toHaveLength(64);
    const fields = { panelId: panel.deps.panelId, nonce, clientSignature, reason: r.reason, minAgentVersion: r.minAgentVersion };
    expect(verifyEd25519(edgeKey.publicKey, rejectSignedBytes(fields), r.panelSignature)).toBe(true);
    expect(
      verifyEd25519(edgeKey.publicKey, rejectSignedBytes({ ...fields, reason: HelloRejectReason.NODE_DISABLED }), r.panelSignature),
    ).toBe(false);
  } finally {
    panel.close();
  }
});
