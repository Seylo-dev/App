// HelloAccepted.panel_signature: the panel proves it holds the identity key
// (the edge ticket key) a node recorded at its first connect, over the
// connection's own values, so a certificate for the panel's address alone
// no longer makes a panel. The bytes and the signature match the Go
// agent's reference vector (go/internal/rpc/accept_test.go).

import { expect, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { CONNECTION_STREAM, encodeFrame, FrameKind, HandshakeSchema, parseFrame } from "@seylo/proto";
import { AgentSession } from "../src/agent-hub/session";
import { acceptSignedBytes, helloSignedBytes, signAccept, verifyEd25519 } from "../src/agent-hub/signature";
import { silentLogger } from "../src/logger";
import { ensureEdgeTicketKey } from "../src/security/edge-ticket-key";
import { agentKey, allCapabilities } from "./fake-agent";
import { testPanel } from "./helpers";
import { addJoinToken } from "./hub-helpers";

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
    nodeId: "node1",
    sessionId: "s1",
    nonce: new Uint8Array(32).fill(0x5a),
    clientSignature: new Uint8Array(64).fill(0xa5),
    panelUrl: "https://panel.example.com",
    panelPin: "",
  };
  expect(hex(acceptSignedBytes(fields))).toBe(
    `7365796c6f2d70616e656c2d6163636570742d7631` +
      `0070616e656c31` +
      `006e6f646531` +
      `00` +
      `7331` +
      `00${"5a".repeat(32)}` +
      `00${"a5".repeat(64)}` +
      `0068747470733a2f2f70616e656c2e6578616d706c652e636f6d` +
      `00`,
  );
  expect(hex(signAccept(key, fields))).toBe(
    "b5d7c1c0d75392e54337776bd4c86d6590eef93f6ff2dc5d94835b5bb4ecaa3c7202f05252a4e80dc4c27cbd631814725cd99301fb4ade0230a836dfdc416508",
  );
});

test("every HelloAccepted carries a signature over this connection that the edge ticket public key verifies", () => {
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
    const clientSignature = new Uint8Array(sign(null, helloSignedBytes(panel.deps.panelId, "", nonce), key.privateKey));
    const hello = create(HandshakeSchema, {
      step: {
        case: "clientHello",
        value: {
          agentVersion: "dev",
          facts: { hostname: "n", capabilities: allCapabilities },
          credential: {
            case: "join",
            value: { token: addJoinToken(panel), publicKey: key.publicKey, signature: clientSignature, requestedName: "" },
          },
        },
      },
    });
    session.receive(encodeFrame({ kind: FrameKind.EVENT, stream: CONNECTION_STREAM, payload: toBinary(HandshakeSchema, hello) }));
    const accepted = frames.map((f) => fromBinary(HandshakeSchema, parseFrame(f).payload)).find((h) => h.step.case === "accepted");
    if (accepted?.step.case !== "accepted") throw new Error("expected HelloAccepted");
    const a = accepted.step.value;
    // Before: panel_signature was empty and a node could not tell this panel from any host with its certificate.
    expect(a.panelSignature).toHaveLength(64);
    expect(a.edgeTicketPublicKey).toEqual(edgeKey.publicKey);
    const fields = {
      panelId: panel.deps.panelId,
      nodeId: a.nodeId,
      sessionId: a.sessionId,
      nonce,
      clientSignature,
      panelUrl: a.panelUrl,
      panelPin: a.panelPin,
    };
    expect(verifyEd25519(a.edgeTicketPublicKey, acceptSignedBytes(fields), a.panelSignature)).toBe(true);
    // Bound to this connection: another nonce or another client signature does not verify.
    expect(verifyEd25519(a.edgeTicketPublicKey, acceptSignedBytes({ ...fields, nonce: new Uint8Array(32) }), a.panelSignature)).toBe(false);
    const other = generateKeyPairSync("ed25519");
    expect(
      verifyEd25519(
        new Uint8Array(Buffer.from(other.publicKey.export({ format: "jwk" }).x as string, "base64url")),
        acceptSignedBytes(fields),
        a.panelSignature,
      ),
    ).toBe(false);
  } finally {
    panel.close();
  }
});

test("the panel id and the identity key are created once and kept on an existing data dir", () => {
  const panel = testPanel();
  try {
    const first = ensureEdgeTicketKey(panel.deps.db, panel.deps.secrets);
    const again = ensureEdgeTicketKey(panel.deps.db, panel.deps.secrets);
    expect(again.publicKey).toEqual(first.publicKey);
  } finally {
    panel.close();
  }
});
