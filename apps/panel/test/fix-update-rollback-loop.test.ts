// The panel's automatic update run (updates.check with auto-update on) does
// not reinstall a release a node's guard rolled back: UpdateAgent bypasses
// the agent's own backoff by design, so before this every check (6 h) went
// install, three minutes, roll back, restart again. A newer release, or a
// person pressing Update now, still updates the node.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { updates } from "@seylo/ops";
import { ReportEventRequestSchema, ReportEventResponseSchema, UpdateTarget } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { alerts, nodes, updateRuns, updateSteps } from "../src/db/schema";
import { releaseSource } from "../src/modules/updates/manifest";
import { panelKey, wasRolledBack } from "../src/modules/updates/rollbacks";
import { checkJob } from "../src/modules/updates/runs";
import type { FakeAgent } from "./fake-agent";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";

let panel: TestPanel;
let url: string;
let owner: Awaited<ReturnType<typeof createUser>>;
const agents: FakeAgent[] = [];
const original = { ...releaseSource };
let savedVersion: string;

beforeEach(async () => {
  panel = testPanel();
  savedVersion = panel.deps.config.version;
  url = listen(panel);
  owner = await createUser(panel, "owner");
});
afterEach(async () => {
  Object.assign(releaseSource, original);
  (panel.deps.config as { version: string }).version = savedVersion;
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

async function join(version: string) {
  const agent = await joinAgent(panel, url, { agentVersion: version, facts: { agentVersion: version } });
  agents.push(agent);
  agent.handle("UpdateAgent", () => ({}));
  return agent;
}

const ok = async <T>(promise: Promise<{ status: number; body: T }>) => {
  const res = await promise;
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

function minisign(message: Uint8Array) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const keyId = Buffer.from("0123456789abcdef", "hex");
  const pub = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
  const sig = sign(null, createHash("blake2b512").update(message).digest(), privateKey);
  const trusted = "timestamp:1762300000\tfile:manifest.json";
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
  const file = `untrusted comment: signature\n${Buffer.concat([Buffer.from("ED"), keyId, sig]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
  return { pub, file };
}

/** Publishes a signed release `version` where the panel looks for the latest one. */
function serveRelease(version: string) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version, minAgent: "0.7.0", panel: { image: "ghcr.io/x/panel", digest: "sha256:aa" }, agents: {} }),
  );
  const { pub, file } = minisign(bytes);
  releaseSource.publicKey = pub;
  releaseSource.fetch = async (u: string) => {
    if (u === releaseSource.latestUrl) {
      return Response.json({
        assets: [
          { name: "manifest.json", browser_download_url: "https://example.test/manifest.json" },
          { name: "manifest.json.minisig", browser_download_url: "https://example.test/manifest.json.minisig" },
        ],
      });
    }
    if (u.endsWith(".minisig")) return new Response(file);
    return new Response(bytes);
  };
}

/** The scheduled release check, as the job runner calls it. */
const scheduledCheck = () => checkJob.run({}, { ...panel.deps, jobId: "test", attempt: 1 });

const runs = () => panel.deps.db.select().from(updateRuns).all();

async function reportResult(agent: FakeAgent, outboxId: number, value: Record<string, unknown>) {
  await agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
    outboxId: BigInt(outboxId),
    event: { payload: { case: "updateResult", value: value as never } },
  });
}

test("after a node rolled a release back, the automatic run leaves it out; Update now still installs it", async () => {
  serveRelease("0.9.0");
  const agent = await join("0.8.0");
  await ok(callOp(panel, updates.setAutoUpdate, { enabled: true }, { cookie: owner.cookie }));

  await scheduledCheck();
  expect(runs()).toHaveLength(1);
  expect(runs()[0]?.trigger).toBe("auto");
  await panel.runner.runDue(panel.deps);
  const stepId = (await agent.waitFor("UpdateAgent"))[0].updateId;
  // The new agent did not reconnect in time; the guard restored 0.8.0.
  await reportResult(agent, 1, {
    target: UpdateTarget.AGENT,
    updateId: stepId,
    fromVersion: "0.8.0",
    toVersion: "0.9.0",
    success: false,
    rolledBack: true,
    error: "the new agent did not reconnect within 3m0s",
  });
  await panel.runner.runDue(panel.deps);
  expect(panel.deps.db.select().from(updateSteps).where(eq(updateSteps.id, stepId)).get()?.status).toBe("rolled_back");
  expect(runs()[0]?.status).toBe("failed");
  expect(wasRolledBack(panel.deps.db, agent.nodeId, "0.9.0")).toBe(true);
  // The update_failed alert says what the automatic runs do now.
  const raised = panel.deps.db.select().from(alerts).where(eq(alerts.event, "update_failed")).all();
  expect(raised.map((a) => a.message)).toEqual([
    "the new agent did not reconnect within 3m0s Rolled back to 0.8.0. Automatic updates leave this node out until a newer release; Update now installs this one.",
  ]);

  // The next checks (every 6 h) do not install it again. Before: a new run and a second UpdateAgent each time.
  await scheduledCheck();
  await scheduledCheck();
  await panel.runner.runDue(panel.deps);
  expect(runs()).toHaveLength(1);
  expect(agent.requests("UpdateAgent")).toHaveLength(1);

  // A person pressing Update now installs it and clears the record.
  const manual = await ok(callOp(panel, updates.updateNode, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
  expect(manual).toMatchObject({ trigger: "manual", targetVersion: "0.9.0", steps: [{ target: "agent", status: "pending" }] });
  await panel.runner.runDue(panel.deps);
  await agent.waitFor("UpdateAgent", 2);
  expect(wasRolledBack(panel.deps.db, agent.nodeId, "0.9.0")).toBe(false);
});

test("a rollback of the agent's own update counts too, other nodes still update, and a newer release is tried", async () => {
  serveRelease("0.9.0");
  const bad = await join("0.8.0");
  const good = await join("0.8.0");
  await ok(callOp(panel, updates.setAutoUpdate, { enabled: true }, { cookie: owner.cookie }));
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  // The agent updated itself on connect (no run step names it) and its guard rolled it back.
  await reportResult(bad, 1, {
    target: UpdateTarget.AGENT,
    updateId: "auto-0.9.0",
    fromVersion: "0.8.0",
    toVersion: "0.9.0",
    success: false,
    rolledBack: true,
  });

  await scheduledCheck();
  const first = panel.deps.db.select().from(updateSteps).all();
  expect(first.map((s) => s.nodeId)).toEqual([good.nodeId]);

  // Finish that run, then a newer release appears: the node is tried again.
  await panel.runner.runDue(panel.deps);
  const goodStep = (await good.waitFor("UpdateAgent"))[0].updateId;
  await reportResult(good, 2, { target: UpdateTarget.AGENT, updateId: goodStep, fromVersion: "0.8.0", toVersion: "0.9.0", success: true });
  await panel.runner.runDue(panel.deps);
  expect(runs().every((r) => r.status === "succeeded")).toBe(true);
  serveRelease("0.9.1");
  await scheduledCheck();
  const active = runs().find((r) => r.status === "running");
  expect(active?.targetVersion).toBe("0.9.1");
  const steps = panel.deps.db
    .select()
    .from(updateSteps)
    .where(eq(updateSteps.runId, active?.id as string))
    .all();
  expect(steps.map((s) => s.nodeId)).toContain(bad.nodeId);
});

test("a later successful update forgets the rollback, and other nodes cannot record one for a node", async () => {
  serveRelease("0.9.0");
  const agent = await join("0.8.0");
  const other = await join("0.8.0");
  await reportResult(agent, 1, {
    target: UpdateTarget.AGENT,
    updateId: "auto-0.9.0",
    toVersion: "0.9.0",
    success: false,
    rolledBack: true,
  });
  expect(wasRolledBack(panel.deps.db, agent.nodeId, "v0.9.0")).toBe(true);
  expect(wasRolledBack(panel.deps.db, other.nodeId, "0.9.0")).toBe(false);
  // A panel result from a node the panel does not run on is ignored.
  await reportResult(other, 2, { target: UpdateTarget.PANEL, updateId: "x", toVersion: "0.9.0", success: false, rolledBack: true });
  expect(wasRolledBack(panel.deps.db, panelKey, "0.9.0")).toBe(false);
  await reportResult(agent, 3, { target: UpdateTarget.AGENT, updateId: "auto-0.9.0", toVersion: "0.9.0", success: true });
  expect(wasRolledBack(panel.deps.db, agent.nodeId, "0.9.0")).toBe(false);
});

test("when the panel's own update to a release was rolled back, the automatic run does not start", async () => {
  serveRelease("0.9.0");
  (panel.deps.config as { version: string }).version = "0.8.0";
  const agent = await join("0.8.0");
  panel.deps.db.update(nodes).set({ isPanelNode: true }).where(eq(nodes.id, agent.nodeId)).run();
  await ok(callOp(panel, updates.setAutoUpdate, { enabled: true }, { cookie: owner.cookie }));
  await reportResult(agent, 1, {
    target: UpdateTarget.PANEL,
    updateId: "step",
    fromVersion: "0.8.0",
    toVersion: "0.9.0",
    success: false,
    rolledBack: true,
    error: "the new panel did not become healthy",
  });
  await scheduledCheck();
  expect(runs()).toHaveLength(0);
  // Updating everything by hand still runs the panel step and the node.
  const manual = await ok(callOp(panel, updates.updatePanel, {}, { cookie: owner.cookie }));
  expect(manual.steps.map((s: { target: string }) => s.target)).toEqual(["panel", "agent"]);
  expect(wasRolledBack(panel.deps.db, panelKey, "0.9.0")).toBe(false);
});
