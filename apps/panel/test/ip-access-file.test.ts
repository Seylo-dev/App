// `seylo panel ip-access on` leaves <data dir>/ip-access-on and restarts
// the panel: the panel turns both switches back on, sets "reopen", writes
// an audit row, removes the file and reopens (ip-access-file.ts).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { auditLog, nodes } from "../src/db/schema";
import { ensurePanelService } from "../src/modules/nodes/panel-service";
import { panelPublishBindCapability, readIpAccessApplied, readPanelAccessWanted } from "../src/modules/settings/ip-access";
import { applyIpAccessFile, ipAccessOnFile } from "../src/modules/settings/ip-access-file";
import { getSetting, setSetting } from "../src/settings";
import { type TestPanel, testPanel } from "./helpers";
import { type FakeAgent, fakeAgent } from "./seed-helpers";

let panel: TestPanel;
let dir: string;
let panelNode: string;
let agent: FakeAgent | null = null;

beforeEach(() => {
  panel = testPanel();
  dir = mkdtempSync(join(tmpdir(), "seylo-ip-access-"));
  panel.deps.config.dataDir = dir;
  panel.deps.config.image = `ghcr.io/seylo-dev/seylo:0.2.1@sha256:${"e".repeat(64)}`;
  panelNode = panel.deps.db
    .insert(nodes)
    .values({ name: "here", publicKey: Buffer.alloc(32, 3), publicIpv4: "203.0.113.10", isPanelNode: true })
    .returning()
    .get().id;
  ensurePanelService(panel.deps);
  // Closed, kept closed, the domain gone: the owner is locked out but for SSH.
  setSetting(panel.deps.db, "panelServeOnIp", false);
  setSetting(panel.deps.db, "panelAgentPortOpen", false);
  setSetting(panel.deps.db, "panelIpAccessOnFailure", "stayClosed");
  setSetting(panel.deps.db, "panelIpAccessApplied", { closed: true, agentPortClosed: true, at: 1, reason: "test", generation: 1 });
});
afterEach(() => {
  agent?.disconnect();
  agent = null;
  panel.close();
  rmSync(dir, { recursive: true, force: true });
});

test("without the file nothing happens", () => {
  expect(applyIpAccessFile(panel.deps)).toBe(false);
  expect(readPanelAccessWanted(panel.deps).serveOnIp).toBe(false);
});

test("the file turns everything back on, is removed, and the agent's connect reopens", () => {
  writeFileSync(join(dir, ipAccessOnFile), "", { mode: 0o600 });
  // At start the panel node's agent has not connected yet.
  expect(applyIpAccessFile(panel.deps)).toBe(true);
  expect(existsSync(join(dir, ipAccessOnFile))).toBe(false);
  expect(readPanelAccessWanted(panel.deps)).toEqual({ serveOnIp: true, agentPortOpen: true, onFailure: "reopen" });
  const row = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "settings.ipAccessOnFromServer")).get();
  expect(row).toMatchObject({ actorType: "system", actorLabel: "the server's command line", outcome: "ok" });
  expect(readIpAccessApplied(panel.deps).closed).toBe(true);

  agent = fakeAgent(panel, panelNode, {}, [], [panelPublishBindCapability]);
  expect(readIpAccessApplied(panel.deps)).toMatchObject({
    closed: false,
    agentPortClosed: false,
    reason: "reopened from the server's command line (sudo seylo panel ip-access on)",
    by: "the server's command line",
  });
  expect(getSetting(panel.deps.db, "panelAccessChoice")?.by).toBe("the server's command line");
});

test("with the agent online it reopens at once, even after a failed roll's hold", () => {
  agent = fakeAgent(panel, panelNode, {}, [], [panelPublishBindCapability]);
  setSetting(panel.deps.db, "panelIpAccessApplied", {
    ...readIpAccessApplied(panel.deps),
    closed: true,
    holdUntil: Date.now() + 3_600_000,
  });
  writeFileSync(join(dir, ipAccessOnFile), "");
  applyIpAccessFile(panel.deps);
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: false, agentPortClosed: false });
  expect(readIpAccessApplied(panel.deps).holdUntil).toBeUndefined();
});
