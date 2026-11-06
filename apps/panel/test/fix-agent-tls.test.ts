// Agents join a panel without a domain over TLS with the panel's pinned key
// (the join command carries --pin), and the join card is told when a
// command would send the agent protocol over plain HTTP.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodes as nodeOps } from "@seylo/ops";
import { agentConnectPath, agentSubprotocol } from "../src/agent-hub/endpoint";
import { nodes } from "../src/db/schema";
import { ensureAgentTls } from "../src/security/agent-tls";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function panelNode(panel: TestPanel, ipv4: string | null) {
  panel.deps.db
    .insert(nodes)
    .values({ name: "panel-node", publicKey: Buffer.alloc(32, 7), isPanelNode: true, publicIpv4: ipv4 })
    .run();
}

test("the key is made once and kept (the pin never changes), private to the panel", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-tls-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const first = ensureAgentTls(dir, 3443);
  const again = ensureAgentTls(dir, 3443);
  expect(again.pin).toBe(first.pin);
  expect(first.pin).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(statSync(join(dir, "agent-tls.key")).mode & 0o777).toBe(0o600);
});

test("join commands use the TLS port with --pin; plain HTTP is flagged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-tls-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const tls = ensureAgentTls(dir, 0);

  const plain = testPanel();
  cleanup.push(() => plain.close());
  panelNode(plain, "203.0.113.9");
  const owner = await createUser(plain, "owner");
  const insecure = await callOp(plain, nodeOps.createJoinToken, {}, { cookie: owner.cookie });
  expect(insecure.body.insecureTransport).toBe(true);
  expect(insecure.body.command).toContain("--panel 'http://203.0.113.9:");
  expect(insecure.body.command).not.toContain("--pin");
  // The agent refuses plain HTTP to another server unless the command says so.
  expect(insecure.body.command).toEndWith(" --insecure");

  const secured = testPanel();
  cleanup.push(() => secured.close());
  secured.deps.agentTls = { port: 3443, pin: tls.pin };
  panelNode(secured, "203.0.113.9");
  const admin = await createUser(secured, "owner");
  const pinned = await callOp(secured, nodeOps.createJoinToken, {}, { cookie: admin.cookie });
  expect(pinned.body.insecureTransport).toBe(false);
  expect(pinned.body.command).toContain("--panel 'https://203.0.113.9:3443'");
  expect(pinned.body.command).toContain(`--pin '${tls.pin}'`);
  expect(pinned.body.command).not.toContain("--insecure");
});

test("the agent endpoint answers on the TLS listener", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-tls-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const tls = ensureAgentTls(dir, 0);
  const panel = testPanel();
  cleanup.push(() => panel.close());
  panel.agentApp.listen({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.certPem, key: tls.keyPem } });
  cleanup.push(async () => {
    await panel.agentApp.stop(true);
  });
  const port = panel.agentApp.server?.port;
  // A real agent connection over wss: the panel sends its ServerHello first.
  const ws = new WebSocket(`wss://127.0.0.1:${port}${agentConnectPath}`, {
    protocols: [agentSubprotocol],
    tls: { rejectUnauthorized: false },
  } as never);
  ws.binaryType = "arraybuffer";
  const first = await new Promise<ArrayBuffer>((resolve, reject) => {
    ws.onmessage = (event) => resolve(event.data as ArrayBuffer);
    ws.onerror = () => reject(new Error("websocket failed"));
  });
  expect(first.byteLength).toBeGreaterThan(5);
  ws.close();
  const get = (path: string) => fetch(`https://127.0.0.1:${port}${path}`, { tls: { rejectUnauthorized: false } } as RequestInit);
  // The agents' health check reads /api/health at the URL they joined (it is public on the main port too).
  expect((await get("/api/health")).status).toBe(200);
  // The rest of the panel is not on this port.
  expect((await get("/api/v1/auth.whoami")).status).toBe(404);
  expect((await get("/")).status).toBe(404);
});
