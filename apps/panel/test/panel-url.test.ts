import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { nodes } from "../src/db/schema";
import { panelUrl } from "../src/modules/nodes/ops";
import { testPanel } from "./helpers";

const panel = testPanel();
afterAll(() => panel.close());

const { db, config } = panel.deps;
const port = config.hostPort ?? config.port;
let nodeId = "";

beforeEach(() => {
  db.delete(nodes).run();
  nodeId = db
    .insert(nodes)
    .values({ name: "panel-node", publicKey: Buffer.alloc(32, 1), isPanelNode: true })
    .returning({ id: nodes.id })
    .get().id;
});

describe("panelUrl (the URL in the join command)", () => {
  test("public IPv4 of the panel node first", () => {
    db.update(nodes)
      .set({ publicIpv4: "203.0.113.9", facts: { privateIpv4: "10.0.0.2" } })
      .where(eq(nodes.id, nodeId))
      .run();
    expect(panelUrl({ db, config, origin: "http://192.168.1.5:3000" })).toBe(`http://203.0.113.9:${port}`);
  });

  test("without a public address: the address the caller reached the panel at", () => {
    db.update(nodes)
      .set({ facts: { privateIpv4: "10.0.0.2" } })
      .where(eq(nodes.id, nodeId))
      .run();
    expect(panelUrl({ db, config, origin: "http://192.168.64.3:3000" })).toBe("http://192.168.64.3:3000");
  });

  test("a loopback origin is skipped for the node's private IPv4", () => {
    db.update(nodes)
      .set({ facts: { privateIpv4: "10.0.0.2" } })
      .where(eq(nodes.id, nodeId))
      .run();
    expect(panelUrl({ db, config, origin: "http://127.0.0.1:3000" })).toBe(`http://10.0.0.2:${port}`);
    expect(panelUrl({ db, config, origin: "http://localhost:3000" })).toBe(`http://10.0.0.2:${port}`);
    expect(panelUrl({ db, config, origin: null })).toBe(`http://10.0.0.2:${port}`);
  });

  test("an IPv6-only panel node: its public IPv6, bracketed", () => {
    db.update(nodes).set({ publicIpv6: "2001:db8::7" }).where(eq(nodes.id, nodeId)).run();
    expect(panelUrl({ db, config, origin: "http://192.168.1.5:3000" })).toBe(`http://[2001:db8::7]:${port}`);
  });
});
