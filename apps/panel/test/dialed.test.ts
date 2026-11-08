// The address each node's agent dials (agent-hub/dialed.ts, added in
// 0.2.1): recorded when its session starts, kept while it is offline and
// across panel restarts, read by the panel access guards.

import { afterEach, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { NodeFactsSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { dialedUrlOf, dialingNodes, dialsDomain, dialsPlainHttp, readDialedUrls, recordDialedUrl } from "../src/agent-hub/dialed";
import type { ConnectedAgent } from "../src/agent-hub/hub";
import { nodes } from "../src/db/schema";
import { getSetting } from "../src/settings";
import { type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
afterEach(() => panel.close());

function addNode(name: string, isPanelNode = false) {
  return panel.deps.db
    .insert(nodes)
    .values({ name, publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))), isPanelNode })
    .returning()
    .get().id;
}

function session(nodeId: string, address: string | null): ConnectedAgent {
  return {
    nodeId,
    sessionId: crypto.randomUUID(),
    facts: create(NodeFactsSchema, { hostname: "n" }),
    host: address ? new URL(address).host : null,
    address,
    transport: {
      call: async () => new Uint8Array(),
      open: () => {
        throw new Error("unused");
      },
    },
    close() {},
  } as unknown as ConnectedAgent;
}

test("a session's address is stored when it starts and kept while the node is offline", () => {
  panel = testPanel();
  const b1 = addNode("b1");
  const agent = session(b1, "https://203.0.113.4:3443");
  expect(panel.deps.agents.register(agent)).toBe(true);
  expect(readDialedUrls(panel.deps.db)[b1]?.url).toBe("https://203.0.113.4:3443");
  panel.deps.agents.unregister(agent);
  expect(dialedUrlOf(panel.deps, b1)).toBe("https://203.0.113.4:3443");

  // It moved to the domain: the next session records that.
  const moved = session(b1, "https://panel.example.com");
  panel.deps.agents.register(moved);
  expect(dialedUrlOf(panel.deps, b1)).toBe("https://panel.example.com");
  panel.deps.agents.unregister(moved);
  expect(getSetting(panel.deps.db, "nodeDialedUrls")?.[b1]?.url).toBe("https://panel.example.com");
});

test("the same address again writes nothing; removed nodes are dropped on the next write", () => {
  panel = testPanel();
  const b1 = addNode("b1");
  const b2 = addNode("b2");
  recordDialedUrl(panel.deps.db, b1, "https://203.0.113.4:3443", 1000);
  recordDialedUrl(panel.deps.db, b1, "https://203.0.113.4:3443", 2000);
  expect(readDialedUrls(panel.deps.db)[b1]?.at).toBe(1000);
  panel.deps.db.delete(nodes).where(eq(nodes.id, b1)).run();
  recordDialedUrl(panel.deps.db, b2, "http://203.0.113.5:3000", 3000);
  expect(Object.keys(readDialedUrls(panel.deps.db))).toEqual([b2]);
});

test("dialing nodes leave out the panel node and disabled nodes, and say who was never seen", () => {
  panel = testPanel();
  addNode("here", true);
  const b1 = addNode("b1");
  const b2 = addNode("b2");
  const off = addNode("off");
  panel.deps.db.update(nodes).set({ disabledAt: new Date() }).where(eq(nodes.id, off)).run();
  recordDialedUrl(panel.deps.db, b1, "http://203.0.113.4:3000");
  expect(dialingNodes(panel.deps).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { id: b1, name: "b1", online: false, url: "http://203.0.113.4:3000" },
    { id: b2, name: "b2", online: false, url: null },
  ]);
});

test("domain and plain-http checks", () => {
  expect(dialsDomain("https://panel.example.com", "panel.example.com")).toBe(true);
  expect(dialsDomain("https://panel.example.com:443", "Panel.Example.com")).toBe(true);
  expect(dialsDomain("https://panel.example.com:8443", "panel.example.com")).toBe(false);
  expect(dialsDomain("http://panel.example.com", "panel.example.com")).toBe(false);
  expect(dialsDomain("https://203.0.113.4:3443", "panel.example.com")).toBe(false);
  expect(dialsDomain(null, "panel.example.com")).toBe(false);
  expect(dialsDomain("https://panel.example.com", null)).toBe(false);
  expect(dialsPlainHttp("http://203.0.113.4:3000")).toBe(true);
  expect(dialsPlainHttp("HTTP://203.0.113.4:3000")).toBe(true);
  expect(dialsPlainHttp("https://203.0.113.4:3443")).toBe(false);
  expect(dialsPlainHttp(null)).toBe(false);
});
