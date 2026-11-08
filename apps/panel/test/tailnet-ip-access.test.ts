// Features 2 and 3 together (0.2.1): the tailnet as the private path that
// lets IP access close, with the real rule (settings/ip-access.ts) and the
// real tailnet path (modules/tailscale/status.ts), nothing stubbed. Serve
// working lets the owner's "Serve on IP address" off close the panel port,
// the public URL moves to the tailnet, the tailnet stopping for 5 minutes
// reopens the port (and the alert says so), it closes again only after an
// hour of working, and keep-closed keeps it closed.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeFactsSchema, TailnetServeState, type TailscaleInfoSchema } from "@seylo/proto";
import { isNull } from "drizzle-orm";
import { alerts, nodes } from "../src/db/schema";
import { compileDesiredState } from "../src/desired";
import { ensurePanelService, panelServiceId } from "../src/modules/nodes/panel-service";
import {
  applyPanelIpAccess,
  panelPublishBindCapability,
  readIpAccessApplied,
  recloseAfterMs,
  writePanelAccessChoice,
} from "../src/modules/settings/ip-access";
import { anyPrivatePathWorking } from "../src/modules/settings/private-paths";
import { panelPublicUrl } from "../src/modules/settings/public-url";
import { tailnetServeCapability } from "../src/modules/tailscale/facts";
import { recordReport, settle, tailnetDownMs } from "../src/modules/tailscale/status";
import { setSetting } from "../src/settings";
import { type TestPanel, testPanel } from "./helpers";
import { type FakeAgent, fakeAgent } from "./seed-helpers";

const dnsName = "panel.tail1234.ts.net";
const owner = "owner@example.com";
let panel: TestPanel;
let panelNode: string;
let agent: FakeAgent;

beforeEach(() => {
  panel = testPanel();
  panel.deps.config.image = `ghcr.io/seylo-dev/seylo:0.2.1@sha256:${"c".repeat(64)}`;
  panel.deps.config.hostPort = 3000;
  setSetting(panel.deps.db, "panelAgentTlsPort", 3443);
  panelNode = panel.deps.db
    .insert(nodes)
    .values({ name: "panel-1", publicKey: Buffer.alloc(32, 7), publicIpv4: "203.0.113.10", isPanelNode: true })
    .returning()
    .get().id;
  ensurePanelService(panel.deps);
  agent = fakeAgent(panel, panelNode, {}, [], [panelPublishBindCapability, tailnetServeCapability]);
});
afterEach(() => {
  agent.disconnect();
  panel.close();
});

type Info = MessageInitShape<typeof TailscaleInfoSchema>;

function running(overrides: Partial<Info> = {}): Info {
  return {
    version: "1.104.5",
    backendState: "Running",
    tailnet: "example.com",
    dnsName: `${dnsName}.`,
    addresses: ["100.101.42.7"],
    magicDns: true,
    https: true,
    loginName: owner,
    serve: { state: TailnetServeState.ACTIVE, url: `https://${dnsName}`, panelAnswers: true, proxy: "unix:/x/tailnet.sock" },
    ...overrides,
  } as Info;
}
const stopped = () => running({ backendState: "Stopped", serve: { state: TailnetServeState.OFF } });

const report = (info: Info, at = Date.now()) =>
  recordReport(panel.deps, create(NodeFactsSchema, { hostname: "panel-1", capabilities: [tailnetServeCapability], tailscale: info }), at);

/** Where the panel port and the agents' TLS port publish in the panel node's desired state. */
function bindAddresses() {
  const state = compileDesiredState(panel.deps.db, panelNode, {
    revision: 1n,
    secrets: panel.deps.secrets,
    contributors: panel.deps.agents.desired.contributors(),
  });
  return state.services.find((s) => s.id === panelServiceId)?.ports.map((p) => p.public?.bindAddress);
}

const openAlerts = (prefix: string) =>
  panel.deps.db
    .select()
    .from(alerts)
    .where(isNull(alerts.resolvedAt))
    .all()
    .filter((a) => a.eventKey.startsWith(prefix));

/** Serve on and working, then the owner turns Serve on IP address off (what settings.updatePanelAccess does once its guards pass). */
function closeOverTheTailnet(onFailure: "reopen" | "stayClosed" = "reopen") {
  setSetting(panel.deps.db, "tailscaleServe", true);
  report(running());
  expect(anyPrivatePathWorking(panel.deps)).toBe(true);
  writePanelAccessChoice(
    panel.deps,
    { serveOnIp: false, onFailure },
    { reason: "Serve on IP address turned off in Settings", by: owner, at: Date.now() },
  );
  return applyPanelIpAccess(panel.deps, "Serve on IP address turned off in Settings", { by: owner, closeNow: true });
}

test("a working tailnet lets IP access close, and the panel's public URL moves to the tailnet", () => {
  expect(bindAddresses()).toEqual(["", ""]);
  expect(panelPublicUrl(panel.deps)).toBe("http://203.0.113.10:3000");

  const applied = closeOverTheTailnet();
  expect(applied).toMatchObject({ closed: true, agentPortClosed: false, by: owner });
  expect(bindAddresses()).toEqual(["127.0.0.1", ""]);
  expect(panelPublicUrl(panel.deps)).toBe(`https://${dnsName}`);
});

test("the tailnet stopping for 5 minutes reopens IP access, and it closes again only after an hour of working", () => {
  closeOverTheTailnet();
  const stoppedAt = Date.now() - tailnetDownMs - 60_000;
  report(stopped(), stoppedAt);
  // The report alone is inside the debounce; the 1-minute job ends it.
  expect(readIpAccessApplied(panel.deps).closed).toBe(true);
  settle(panel.deps);
  const reopened = readIpAccessApplied(panel.deps);
  expect(reopened).toMatchObject({ closed: false, by: "system" });
  expect(reopened.reason).toContain("stopped working");
  expect(bindAddresses()).toEqual(["", ""]);
  expect(panelPublicUrl(panel.deps)).toBe("http://203.0.113.10:3000");
  const alert = openAlerts("tailnet-stopped:")[0];
  expect(alert?.message).toContain("reopen");

  // Back: the path works at once, IP access waits an hour before it closes again.
  report(running());
  expect(anyPrivatePathWorking(panel.deps)).toBe(true);
  expect(applyPanelIpAccess(panel.deps, "the 1-minute job").closed).toBe(false);
  expect(openAlerts("tailnet-stopped:")).toEqual([]);
  // An hour on, the 1-minute job closes it again.
  const again = applyPanelIpAccess(panel.deps, "the 1-minute job", { now: Date.now() + recloseAfterMs + 60_000 });
  expect(again).toMatchObject({ closed: true, by: "system" });
  expect(again.reason).toContain("has worked for an hour");
  expect(bindAddresses()).toEqual(["127.0.0.1", ""]);
});

test("keep-closed: the tailnet stopping leaves IP access closed", () => {
  closeOverTheTailnet("stayClosed");
  report(stopped(), Date.now() - tailnetDownMs - 60_000);
  settle(panel.deps);
  expect(anyPrivatePathWorking(panel.deps)).toBe(false);
  expect(readIpAccessApplied(panel.deps).closed).toBe(true);
  expect(bindAddresses()).toEqual(["127.0.0.1", ""]);
  expect(openAlerts("tailnet-stopped:")[0]?.message).not.toContain("reopened");
});

test("an offline panel agent flips nothing, however long the tailnet looked down", () => {
  closeOverTheTailnet();
  report(stopped(), Date.now() - tailnetDownMs - 60_000);
  agent.disconnect();
  settle(panel.deps);
  expect(readIpAccessApplied(panel.deps).closed).toBe(true);
  agent = fakeAgent(panel, panelNode, {}, [], [panelPublishBindCapability, tailnetServeCapability]);
});
