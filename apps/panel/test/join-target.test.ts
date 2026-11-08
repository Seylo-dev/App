// Where new nodes join (nodes/join-target.ts) with panel access (0.2.1): a
// name the panel does not own (a tailnet's ts.net name) is never the join
// URL, and a target whose port is closed is refused instead of handing out
// a command that cannot connect.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { nodes as nodeOps, OpError } from "@seylo/ops";
import { nodes } from "../src/db/schema";
import { agentJoinTarget, panelUrl } from "../src/modules/nodes/join-target";
import { setSetting } from "../src/settings";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
const config = { hostPort: 3000, port: 3000, host: "0.0.0.0" };
const tls = { port: 3443, pin: `sha256:${"a".repeat(64)}` };

beforeEach(() => {
  panel = testPanel();
  panel.deps.db
    .insert(nodes)
    .values({ name: "here", publicKey: Buffer.alloc(32, 5), isPanelNode: true })
    .run();
});
afterEach(() => panel.close());

const closedState = (agentPortClosed: boolean) =>
  setSetting(panel.deps.db, "panelIpAccessApplied", { closed: true, agentPortClosed, at: 1, reason: "test" });

test("only an IP literal origin becomes the join URL", () => {
  const db = panel.deps.db;
  expect(panelUrl({ db, config, origin: "https://here.tail1234.ts.net" })).toBe("http://127.0.0.1:3000");
  expect(panelUrl({ db, config, origin: "http://myserver.lan:3000" })).toBe("http://127.0.0.1:3000");
  expect(panelUrl({ db, config, origin: "http://192.168.64.3:3000" })).toBe("http://192.168.64.3:3000");
  expect(panelUrl({ db, config, origin: "http://[2001:db8::5]:3000" })).toBe("http://[2001:db8::5]:3000");
  expect(panelUrl({ db, config, origin: "http://[::1]:3000" })).toBe("http://127.0.0.1:3000");
});

test("with the agents' port closed and no active domain, joining is refused", () => {
  const db = panel.deps.db;
  const origin = "http://203.0.113.10:3000";
  expect(agentJoinTarget({ db, config, origin, agentTls: tls }).url).toBe("https://203.0.113.10:3443");
  closedState(false);
  // IP access closed, agents' port open: nodes still join over it.
  expect(agentJoinTarget({ db, config, origin, agentTls: tls }).url).toBe("https://203.0.113.10:3443");
  closedState(true);
  expect(() => agentJoinTarget({ db, config, origin, agentTls: tls })).toThrow(OpError);
  try {
    agentJoinTarget({ db, config, origin, agentTls: tls });
  } catch (error) {
    expect((error as OpError).code).toBe("CONFLICT");
    expect((error as OpError).message).toContain("Open the agents' port first");
  }
  // A domain that is not active yet does not help; an active one is where they join.
  setSetting(db, "panelDomain", "panel.example.com");
  expect(() => agentJoinTarget({ db, config, origin, agentTls: tls })).toThrow("Open the agents' port first");
  setSetting(db, "panelDomainStatus", { domain: "panel.example.com", state: "active", message: "", checkedAt: Date.now() });
  expect(agentJoinTarget({ db, config, origin, agentTls: tls }).url).toBe("https://panel.example.com");
});

test("without an agents' port, closed IP access refuses the plain-HTTP join", () => {
  const db = panel.deps.db;
  const origin = "http://203.0.113.10:3000";
  closedState(false);
  expect(() => agentJoinTarget({ db, config, origin, agentTls: null })).toThrow("Serve on IP address");
  // The panel's own server can still join over loopback.
  expect(agentJoinTarget({ db, config, origin: null, agentTls: null }).url).toBe("http://127.0.0.1:3000");
});

test("createJoinToken answers the refusal as CONFLICT", async () => {
  panel.deps.db.update(nodes).set({ publicIpv4: "203.0.113.10" }).run();
  (panel.deps as { agentTls: typeof tls | null }).agentTls = tls;
  closedState(true);
  const { cookie } = await createUser(panel, "owner");
  const refused = await callOp(panel, nodeOps.createJoinToken, {}, { cookie });
  expect(refused.status).toBe(409);
  expect(refused.body.error.details.reason).toBe("agentPortClosed");
});
