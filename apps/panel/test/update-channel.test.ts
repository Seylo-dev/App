// The release channel (Settings > Updates, owner only). Before it the check
// read only GitHub's releases/latest, so an install never saw a pre-release
// (rc.1 needed a manual staging script) and nothing picked a version. On
// "prerelease" the check lists the releases and takes the highest version
// (0.2.0-rc.1 < 0.2.0-rc.2 < 0.2.0), with its signed manifest verified the
// same way. Nothing ever offers a downgrade, and a run keeps the release it
// started with.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { updates } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { auditLog, updateRuns } from "../src/db/schema";
import { releaseSource } from "../src/modules/updates/manifest";
import type { FakeAgent } from "./fake-agent";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";
import { serveReleases } from "./release-fakes";

let panel: TestPanel;
let url: string;
let owner: Awaited<ReturnType<typeof createUser>>;
let admin: Awaited<ReturnType<typeof createUser>>;
const agents: FakeAgent[] = [];
const original = { ...releaseSource };
let savedVersion: string;

beforeEach(async () => {
  panel = testPanel();
  savedVersion = panel.deps.config.version;
  url = listen(panel);
  owner = await createUser(panel, "owner");
  admin = await createUser(panel, "admin");
});
afterEach(async () => {
  Object.assign(releaseSource, original);
  (panel.deps.config as { version: string }).version = savedVersion;
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

const ok = async <T>(promise: Promise<{ status: number; body: T }>) => {
  const res = await promise;
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

const runningAs = (version: string) => {
  (panel.deps.config as { version: string }).version = version;
};

async function join(version: string) {
  const agent = await joinAgent(panel, url, { agentVersion: version, facts: { agentVersion: version } });
  agents.push(agent);
  agent.handle("UpdateAgent", () => ({}));
  return agent;
}

const releases = [
  { tag: "v0.2.0-rc.2" },
  { tag: "nightly" },
  { tag: "v0.3.0", draft: true },
  { tag: "v0.2.0-rc.1" },
  { tag: "v0.1.1" },
  { tag: "v0.1.0" },
];

test("the stable channel offers releases/latest only; pre-release takes the highest version of the list", async () => {
  runningAs("0.1.1");
  const fetched = serveReleases(releases);
  const stable = await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  expect(stable).toMatchObject({
    channel: "stable",
    canChangeChannel: true,
    checkError: null,
    panel: { currentVersion: "0.1.1", latestVersion: "0.1.1", updateAvailable: false, offeredVersion: null, latestIsPrerelease: false },
  });
  expect(fetched).not.toContain(releaseSource.listUrl);

  const pre = await ok(callOp(panel, updates.setChannel, { channel: "prerelease" }, { cookie: owner.cookie }));
  // Before: no channel at all, and the check never read the list.
  expect(fetched).toContain(releaseSource.listUrl);
  expect(pre).toMatchObject({
    channel: "prerelease",
    checkError: null,
    panel: { latestVersion: "0.2.0-rc.2", updateAvailable: true, offeredVersion: "0.2.0-rc.2", latestIsPrerelease: true },
  });
  // The draft and the tag that is not a version were never fetched.
  expect(fetched.some((u) => u.includes("v0.3.0") || u.includes("nightly"))).toBe(false);
  // The check every 6 hours stays on the channel.
  expect((await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }))).panel.latestVersion).toBe("0.2.0-rc.2");

  // 0.2.0 final sorts after its release candidates.
  serveReleases([{ tag: "v0.2.0" }, ...releases]);
  expect((await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }))).panel.offeredVersion).toBe("0.2.0");
});

test("a pre-release whose manifest names another version, or that has none, is refused and the last good one kept", async () => {
  runningAs("0.1.1");
  serveReleases(releases);
  await ok(callOp(panel, updates.setChannel, { channel: "prerelease" }, { cookie: owner.cookie }));
  // A correctly signed old manifest attached to a newer tag.
  serveReleases([{ tag: "v0.2.0-rc.3", manifestVersion: "0.1.0" }, ...releases]);
  const replayed = await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  expect(replayed.checkError).toBe("The newest release (v0.2.0-rc.3) carries the manifest of 0.1.0.");
  expect(replayed.panel.latestVersion).toBe("0.2.0-rc.2");
  serveReleases([{ tag: "v0.2.0-rc.3", noManifest: true }, ...releases]);
  const missing = await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  expect(missing.checkError).toBe("The newest release (v0.2.0-rc.3) has no signed manifest.");
  expect(missing.panel.offeredVersion).toBe("0.2.0-rc.2");
});

test("back on stable a pre-release keeps running: no downgrade of the panel or a node until a newer stable release", async () => {
  runningAs("0.2.0-rc.2");
  const agent = await join("0.2.0-rc.2");
  serveReleases(releases);
  await ok(callOp(panel, updates.setChannel, { channel: "prerelease" }, { cookie: owner.cookie }));
  const back = await ok(callOp(panel, updates.setChannel, { channel: "stable" }, { cookie: owner.cookie }));
  expect(back).toMatchObject({ channel: "stable", panel: { latestVersion: "0.1.1", updateAvailable: false, offeredVersion: null } });
  expect(back.nodes).toMatchObject([{ nodeId: agent.nodeId, version: "0.2.0-rc.2", updateAvailable: false }]);
  expect((await callOp(panel, updates.updatePanel, {}, { cookie: owner.cookie })).status).toBe(409);
  // Before: Update now on the node made a step back to 0.1.1.
  const node = await callOp(panel, updates.updateNode, { nodeId: agent.nodeId }, { cookie: owner.cookie });
  expect(node.status).toBe(409);
  expect(JSON.stringify(node.body)).toContain("already runs 0.2.0-rc.2, which is not older than 0.1.1");
  expect(panel.deps.db.select().from(updateRuns).all()).toHaveLength(0);

  serveReleases([{ tag: "v0.2.0" }, ...releases]);
  const final = await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  expect(final.panel).toMatchObject({ latestVersion: "0.2.0", offeredVersion: "0.2.0" });
  expect(final.nodes[0]?.updateAvailable).toBe(true);
});

test("only the owner changes the channel, and every change is in the audit log", async () => {
  serveReleases(releases);
  const denied = await callOp(panel, updates.setChannel, { channel: "prerelease" }, { cookie: admin.cookie });
  expect(denied.status).toBe(403);
  const asAdmin = await ok(callOp(panel, updates.status, {}, { cookie: admin.cookie }));
  expect(asAdmin).toMatchObject({ channel: "stable", canChangeChannel: false });
  await ok(callOp(panel, updates.setChannel, { channel: "prerelease" }, { cookie: owner.cookie }));
  const rows = panel.deps.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.opId, "updates.setChannel")))
    .all();
  expect(rows.map((r) => [r.actorId, r.outcome, r.input])).toEqual([
    [admin.user.id, "error", { channel: "prerelease" }],
    [owner.user.id, "ok", { channel: "prerelease" }],
  ]);
});

test("after a switch nothing from the other channel is offered while the check fails", async () => {
  runningAs("0.1.1");
  serveReleases(releases);
  await ok(callOp(panel, updates.setChannel, { channel: "prerelease" }, { cookie: owner.cookie }));
  releaseSource.fetch = async () => {
    throw new Error("offline");
  };
  const back = await ok(callOp(panel, updates.setChannel, { channel: "stable" }, { cookie: owner.cookie }));
  expect(back).toMatchObject({
    channel: "stable",
    checkError: "Could not reach GitHub to check for updates.",
    panel: { latestVersion: null, offeredVersion: null },
  });
  expect((await callOp(panel, updates.updatePanel, {}, { cookie: owner.cookie })).status).toBe(409);
});

test("a run keeps the release it started with when a later check finds a newer one", async () => {
  const agent = await join("0.1.1");
  const second = await join("0.1.1");
  serveReleases(releases);
  await ok(callOp(panel, updates.setChannel, { channel: "prerelease" }, { cookie: owner.cookie }));
  const run = await ok(callOp(panel, updates.updatePanel, {}, { cookie: owner.cookie }));
  expect(run.steps.map((s: { toVersion: string }) => s.toVersion)).toEqual(["0.2.0-rc.2", "0.2.0-rc.2"]);
  await panel.runner.runDue(panel.deps);
  const first = (await agent.waitFor("UpdateAgent"))[0];
  // rc.3 comes out while the first node updates.
  serveReleases([{ tag: "v0.2.0-rc.3" }, ...releases]);
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  agent.event({ payload: { case: "nodeFacts", value: { agentVersion: "0.2.0-rc.2" } } });
  await Bun.sleep(50);
  const { advanceRun } = await import("../src/modules/updates/runs");
  while ((await advanceRun(panel.deps, run.id)) === 0) {}
  const next = (await second.waitFor("UpdateAgent"))[0];
  // Before: the second node got rc.3's manifest under a step for rc.2 and timed out.
  expect(new TextDecoder().decode(next.manifest)).toContain('"0.2.0-rc.2"');
  expect(next.targetVersion).toBe("0.2.0-rc.2");
  expect(Buffer.from(next.manifestSignature).equals(Buffer.from(first.manifestSignature))).toBe(true);
});
