// IP access (added in 0.2.1): the rule that decides whether the panel port
// and the agents' port publish on 127.0.0.1 only, and what applying a
// change does. A fake panel-node agent stands in for the real one: it is
// online and advertises panel.publish-bind.v1 unless a test says
// otherwise. The domain is the private path; the tailnet is a stand-in.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { DeployProgressSchema, DeployStage, EventSchema } from "@seylo/proto";
import { and, desc, eq } from "drizzle-orm";
import { recordDialedUrl } from "../src/agent-hub/dialed";
import { alerts, auditLog, deployments, nodes, services, updateRuns } from "../src/db/schema";
import { compileDesiredState } from "../src/desired";
import { ensurePanelService, panelServiceId } from "../src/modules/nodes/panel-service";
import {
  actualIpAccess,
  applyPanelIpAccess,
  decidePanelIpAccess,
  failedRollHoldMs,
  panelPublishBindCapability,
  readIpAccessApplied,
  readPanelAccessWanted,
  recloseAfterMs,
} from "../src/modules/settings/ip-access";
import { domainPath, type PrivatePathSource, registerPrivatePath } from "../src/modules/settings/private-paths";
import { getSetting, setSetting } from "../src/settings";
import { type TestPanel, testPanel } from "./helpers";
import { type FakeAgent, fakeAgent } from "./seed-helpers";

const digest = `sha256:${"c".repeat(64)}`;
const hour = recloseAfterMs;
let panel: TestPanel;
let panelNode: string;
let agent: FakeAgent | null;
const unregister: (() => void)[] = [];

function connect(capable = true): FakeAgent {
  agent?.disconnect();
  agent = fakeAgent(panel, panelNode, {}, [], capable ? [panelPublishBindCapability] : []);
  return agent;
}

function activeDomain(domain = "panel.example.com", since = Date.now() - 2 * hour) {
  setSetting(panel.deps.db, "panelDomain", domain);
  setSetting(panel.deps.db, "panelDomainStatus", {
    domain,
    state: "active",
    message: "",
    checkedAt: Date.now(),
    working: true,
    since,
    failedChecks: 0,
  });
}

function domainDown(domain = "panel.example.com", at = Date.now()) {
  setSetting(panel.deps.db, "panelDomainStatus", {
    domain,
    state: "issuing_certificate",
    message: "",
    checkedAt: at,
    working: false,
    since: at,
    failedChecks: 2,
  });
}

function want(values: { serveOnIp?: boolean; agentPortOpen?: boolean; onFailure?: "reopen" | "stayClosed" }) {
  if (values.serveOnIp !== undefined) setSetting(panel.deps.db, "panelServeOnIp", values.serveOnIp);
  if (values.agentPortOpen !== undefined) setSetting(panel.deps.db, "panelAgentPortOpen", values.agentPortOpen);
  if (values.onFailure !== undefined) setSetting(panel.deps.db, "panelIpAccessOnFailure", values.onFailure);
}

function addNode(name: string) {
  return panel.deps.db
    .insert(nodes)
    .values({ name, publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) })
    .returning()
    .get().id;
}

const panelGeneration = () => panel.deps.db.select().from(services).where(eq(services.id, panelServiceId)).get()?.generation ?? 0;
const securityAlerts = () =>
  panel.deps.db.select().from(alerts).where(eq(alerts.event, "security_change")).orderBy(desc(alerts.createdAt)).all();

function panelSpec() {
  const state = compileDesiredState(panel.deps.db, panelNode, {
    revision: 1n,
    secrets: panel.deps.secrets,
    contributors: panel.deps.agents.desired.contributors(),
  });
  return state.services.find((s) => s.id === panelServiceId);
}

beforeEach(() => {
  panel = testPanel();
  panel.deps.config.image = `ghcr.io/seylo-dev/seylo:0.2.1@${digest}`;
  panel.deps.config.hostPort = 3000;
  setSetting(panel.deps.db, "panelAgentTlsPort", 3443);
  panelNode = panel.deps.db
    .insert(nodes)
    .values({ name: "here", publicKey: Buffer.alloc(32, 7), publicIpv4: "203.0.113.10", isPanelNode: true })
    .returning()
    .get().id;
  ensurePanelService(panel.deps);
  agent = null;
  connect();
});
afterEach(() => {
  agent?.disconnect();
  for (const remove of unregister.splice(0)) remove();
  registerPrivatePath(domainPath);
  panel.close();
});

test("the defaults are 0.2.0's: open, and nothing changes", () => {
  activeDomain();
  expect(readPanelAccessWanted(panel.deps)).toEqual({ serveOnIp: true, agentPortOpen: true, onFailure: "reopen" });
  const before = panelGeneration();
  expect(applyPanelIpAccess(panel.deps, "test")).toMatchObject({ closed: false, agentPortClosed: false, at: 0 });
  expect(panelGeneration()).toBe(before);
  expect(actualIpAccess(panel.deps)).toEqual({ ip: "open", agentPort: "open" });
  // A spec without bind addresses hashes as in 0.2.0.
  expect(panelSpec()?.ports.map((p) => p.public?.bindAddress)).toEqual(["", ""]);
});

test("truth table: the switch, the capability, a working path and stayClosed", () => {
  const decide = () => {
    const d = decidePanelIpAccess(panel.deps);
    return { closed: d.closed, agentPortClosed: d.agentPortClosed };
  };
  activeDomain();
  expect(decide()).toEqual({ closed: false, agentPortClosed: false });

  want({ serveOnIp: false });
  expect(decide()).toEqual({ closed: true, agentPortClosed: false });

  // An agent without the capability cannot bind 127.0.0.1: it stays open.
  connect(false);
  expect(decide().closed).toBe(false);
  expect(decidePanelIpAccess(panel.deps).why).toContain("cannot publish");
  // (Its connect applies the rule; these checks start from open again.)
  connect(true);
  setSetting(panel.deps.db, "panelIpAccessApplied", { closed: false, agentPortClosed: false, at: 1, reason: "test" });

  // No working path: open in reopen mode, and in stayClosed mode unless it is already closed.
  domainDown();
  expect(decide().closed).toBe(false);
  want({ onFailure: "stayClosed" });
  expect(decide().closed).toBe(false);
  setSetting(panel.deps.db, "panelIpAccessApplied", { closed: true, agentPortClosed: false, at: 1, reason: "test" });
  expect(decide().closed).toBe(true);
  want({ onFailure: "reopen" });
  expect(decide().closed).toBe(false);
});

test("the agents' port closes only with IP access, and only when every other node dials the domain", () => {
  activeDomain();
  want({ serveOnIp: true, agentPortOpen: false });
  expect(decidePanelIpAccess(panel.deps).agentPortClosed).toBe(false);
  want({ serveOnIp: false });
  // The panel node alone: nothing else needs the port.
  expect(decidePanelIpAccess(panel.deps).agentPortClosed).toBe(true);

  const b1 = addNode("b1");
  // A node the panel never saw connect might dial the port.
  expect(decidePanelIpAccess(panel.deps).agentPortClosed).toBe(false);
  recordDialedUrl(panel.deps.db, b1, "https://203.0.113.20:3443");
  expect(decidePanelIpAccess(panel.deps).agentPortClosed).toBe(false);
  recordDialedUrl(panel.deps.db, b1, "https://panel.example.com");
  expect(decidePanelIpAccess(panel.deps).agentPortClosed).toBe(true);
  // A disabled node does not count.
  const b2 = addNode("b2");
  expect(decidePanelIpAccess(panel.deps).agentPortClosed).toBe(false);
  panel.deps.db.update(nodes).set({ disabledAt: new Date() }).where(eq(nodes.id, b2)).run();
  expect(decidePanelIpAccess(panel.deps).agentPortClosed).toBe(true);

  // No agents' port at all: nothing to close.
  setSetting(panel.deps.db, "panelAgentTlsPort", null as never);
  expect(decidePanelIpAccess(panel.deps).agentPortClosed).toBe(false);
});

test("closing rolls the panel once: a new generation, 127.0.0.1 in the spec, an alert and an audit row", () => {
  activeDomain();
  want({ serveOnIp: false, agentPortOpen: false });
  const before = panelGeneration();
  const applied = applyPanelIpAccess(panel.deps, "the panel domain works again");
  expect(applied).toMatchObject({ closed: true, agentPortClosed: true, by: "system", generation: before + 1 });
  expect(panelGeneration()).toBe(before + 1);
  expect(
    panel.deps.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.serviceId, panelServiceId), eq(deployments.status, "live")))
      .all(),
  ).toHaveLength(1);
  expect(panel.deps.agents.desired.takeDirty()).toContainEqual({ nodeId: panelNode });

  const spec = panelSpec();
  expect(spec?.generation).toBe(BigInt(before + 1));
  expect(spec?.ports.map((p) => [p.public?.hostPort, p.public?.bindAddress])).toEqual([
    [3000, "127.0.0.1"],
    [3443, "127.0.0.1"],
  ]);
  expect(securityAlerts()[0]?.title).toBe("IP access and the agents' port closed");
  const row = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "settings.ipAccessChanged")).get();
  expect(row).toMatchObject({ actorType: "system", actorLabel: "system", input: { closed: true, agentPortClosed: true } });

  // Until the agent runs the new generation, the card does not claim it.
  expect(actualIpAccess(panel.deps)).toEqual({ ip: "unknown", agentPort: "unknown" });
  agent?.snapshot({ epoch: 1n, services: [{ serviceId: panelServiceId, generation: BigInt(before + 1) }] });
  expect(actualIpAccess(panel.deps)).toEqual({ ip: "closed", agentPort: "closed" });

  // The same answer again changes nothing.
  applyPanelIpAccess(panel.deps, "a scheduled check");
  expect(panelGeneration()).toBe(before + 1);
  expect(securityAlerts()).toHaveLength(1);
});

test("an offline or restarting agent flips nothing; its next connect applies", () => {
  activeDomain();
  want({ serveOnIp: false });
  applyPanelIpAccess(panel.deps, "test");
  expect(readIpAccessApplied(panel.deps).closed).toBe(true);
  const generation = panelGeneration();

  agent?.disconnect();
  agent = null;
  domainDown();
  expect(applyPanelIpAccess(panel.deps, "a scheduled check").closed).toBe(true);
  expect(panelGeneration()).toBe(generation);

  // The connect listener decides again: the domain is down, so it reopens.
  connect();
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: false, reason: "the panel domain panel.example.com stopped working" });
  expect(panelGeneration()).toBe(generation + 1);
});

test("an update run holds every change until it finished", () => {
  activeDomain();
  want({ serveOnIp: false });
  const run = panel.deps.db.insert(updateRuns).values({ targetVersion: "0.2.2", trigger: "manual" }).returning().get();
  expect(applyPanelIpAccess(panel.deps, "test").closed).toBe(false);
  panel.deps.db.update(updateRuns).set({ status: "succeeded" }).where(eq(updateRuns.id, run.id)).run();
  expect(applyPanelIpAccess(panel.deps, "test").closed).toBe(true);
});

test("anti-flap: after an automatic reopen it closes again only once a path worked for an hour", () => {
  const t0 = Date.now();
  activeDomain("panel.example.com", t0 - 3 * hour);
  want({ serveOnIp: false });
  applyPanelIpAccess(panel.deps, "test", { now: t0 });

  domainDown("panel.example.com", t0 + 60_000);
  const reopened = applyPanelIpAccess(panel.deps, "a scheduled check", { now: t0 + 60_000 });
  expect(reopened).toMatchObject({ closed: false, reopenedAt: t0 + 60_000 });
  expect(securityAlerts()[0]?.title).toBe("IP access reopened");
  expect(securityAlerts()[0]?.message).toContain("closes again by itself");

  // Back after 10 minutes: it waits an hour from then.
  const back = t0 + 10 * 60_000;
  activeDomain("panel.example.com", back);
  expect(decidePanelIpAccess(panel.deps, back + 60_000)).toMatchObject({ closed: false, reclosesAt: back + hour });
  expect(applyPanelIpAccess(panel.deps, "a scheduled check", { now: back + hour - 1 }).closed).toBe(false);
  const closed = applyPanelIpAccess(panel.deps, "a scheduled check", { now: back + hour });
  expect(closed.closed).toBe(true);
  expect(closed.reason).toBe("the panel domain panel.example.com has worked for an hour since IP access reopened");
  expect(closed.reopenedAt).toBeUndefined();
});

test("anti-flap counts a path that never stopped from the reopen", () => {
  const t0 = Date.now();
  // A tailnet that kept working while the domain failed: the hour counts from the reopen, not from before it.
  unregister.push(
    registerPrivatePath({
      kind: "tailnet",
      state: () => ({ url: "https://here.tail1234.ts.net", working: true, since: new Date(t0 - 24 * hour) }),
      provenBy: () => false,
    } satisfies PrivatePathSource),
  );
  want({ serveOnIp: false });
  setSetting(panel.deps.db, "panelIpAccessApplied", { closed: false, agentPortClosed: false, at: t0, reason: "x", reopenedAt: t0 });
  expect(decidePanelIpAccess(panel.deps, t0 + 1000).reclosesAt).toBe(t0 + hour);
  // The owner choosing again forgets the wait.
  expect(
    applyPanelIpAccess(panel.deps, "turned off in Settings", { by: "owner@example.com", resetHold: true, now: t0 + 1000 }).closed,
  ).toBe(true);
});

test("stayClosed keeps it closed when the path fails, and still opens without the capability", () => {
  activeDomain();
  want({ serveOnIp: false, onFailure: "stayClosed" });
  applyPanelIpAccess(panel.deps, "test");
  domainDown();
  expect(applyPanelIpAccess(panel.deps, "a scheduled check").closed).toBe(true);
  // A downgraded agent ignores the bind address: record the truth.
  connect(false);
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: false });
});

test("a panel that is not its node's service never closes", () => {
  panel.deps.db.delete(services).where(eq(services.id, panelServiceId)).run();
  activeDomain();
  want({ serveOnIp: false });
  const decision = decidePanelIpAccess(panel.deps);
  expect(decision.closed).toBe(false);
  expect(decision.why).toContain("does not run as a service");
});

test("a failed close puts the switch back on and holds; a failed reopen records the closed port", () => {
  activeDomain();
  want({ serveOnIp: false });
  const closing = applyPanelIpAccess(panel.deps, "test");
  const failed = (generation: number) =>
    panel.deps.agents.emitEvent(
      panelNode,
      create(EventSchema, {
        payload: {
          case: "deployProgress",
          value: create(DeployProgressSchema, {
            serviceId: panelServiceId,
            generation: BigInt(generation),
            stage: DeployStage.FAILED,
            message: "health check timed out",
          }),
        },
      }),
    );

  // Another generation's failure is not ours.
  failed((closing.generation ?? 0) - 1);
  expect(readIpAccessApplied(panel.deps).closed).toBe(true);

  failed(closing.generation ?? 0);
  const after = readIpAccessApplied(panel.deps);
  expect(after).toMatchObject({ closed: false, agentPortClosed: false, by: "system", generation: (closing.generation ?? 0) + 1 });
  expect(after.reason).toContain("did not start with the port closed");
  expect(after.reason).toContain("health check timed out");
  expect(readPanelAccessWanted(panel.deps).serveOnIp).toBe(true);
  expect(getSetting(panel.deps.db, "panelAccessChoice")?.by).toBe("system");
  // Nothing tries again by itself.
  expect(applyPanelIpAccess(panel.deps, "a scheduled check").closed).toBe(false);

  // Closed again by the owner, then the reopen fails: the closed container is back, and that is what is recorded.
  want({ serveOnIp: false });
  const now = Date.now();
  applyPanelIpAccess(panel.deps, "turned off in Settings", { by: "owner@example.com", resetHold: true, now });
  want({ serveOnIp: true });
  const reopening = applyPanelIpAccess(panel.deps, "turned on in Settings", { by: "owner@example.com", now });
  expect(reopening.closed).toBe(false);
  failed(reopening.generation ?? 0);
  const stuck = readIpAccessApplied(panel.deps);
  expect(stuck.closed).toBe(true);
  expect(stuck.reason).toContain("did not start with the port open");
  // Held for a while, then it tries again.
  expect(applyPanelIpAccess(panel.deps, "a scheduled check", { now: now + 60_000 }).closed).toBe(true);
  expect(applyPanelIpAccess(panel.deps, "a scheduled check", { now: now + failedRollHoldMs + 1 }).closed).toBe(false);
});

test("a change that follows the switches names who set them, also when it applies later", () => {
  activeDomain();
  agent?.disconnect();
  agent = null;
  setSetting(panel.deps.db, "panelServeOnIp", false);
  setSetting(panel.deps.db, "panelAccessChoice", { reason: "Serve on IP address turned off in Settings", by: "owner@example.com", at: 1 });
  connect();
  expect(readIpAccessApplied(panel.deps)).toMatchObject({
    closed: true,
    reason: "Serve on IP address turned off in Settings",
    by: "owner@example.com",
  });
});
