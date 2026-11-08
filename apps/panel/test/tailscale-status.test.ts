// The tailnet path's state (added in 0.2.1, modules/tailscale/status.ts):
// reports from the panel node's agent, the 5-minute debounce, an offline or
// reconnecting agent flipping nothing, Serve off stopping the path at once,
// applyPanelIpAccess on every change with the tailnet-stopped alert saying
// what happened to IP access, and the key expiry, needs-login and
// needs-approval alerts. The clock is passed in; the hub's online state is
// stubbed.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { NodeFactsSchema, TailnetServeState, type TailscaleInfoSchema } from "@seylo/proto";
import { and, eq, isNull } from "drizzle-orm";
import { alerts, nodes } from "../src/db/schema";
import * as ipAccess from "../src/modules/settings/ip-access";
import { anyPrivatePathWorking, listPrivatePaths } from "../src/modules/settings/private-paths";
import { onOtherTailnet, tailnetServeCapability } from "../src/modules/tailscale/facts";
import { agentDisconnected, recordReport, serveTurnedOff, settle, tailnetDownMs, tailnetPathState } from "../src/modules/tailscale/status";
import { getSetting, setSetting } from "../src/settings";
import { type TestPanel, testPanel } from "./helpers";

const dnsName = "panel.tail1234.ts.net";
const t0 = Date.parse("2026-11-08T12:00:00Z");
const minute = 60_000;

let panel: TestPanel;
let online = true;
let applies: string[] = [];
let apply: ReturnType<typeof spyOn<typeof ipAccess, "applyPanelIpAccess">>;

beforeEach(() => {
  panel = testPanel();
  panel.deps.db
    .insert(nodes)
    .values({
      name: "panel-1",
      publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
      publicIpv4: "203.0.113.10",
      isPanelNode: true,
    })
    .run();
  online = true;
  panel.deps.agents.isOnline = () => online;
  applies = [];
  // Records what applyPanelIpAccess (settings/ip-access.ts) is asked; a test sets what it
  // answers. tailnet-ip-access.test.ts runs the real rule.
  apply = spyOn(ipAccess, "applyPanelIpAccess").mockImplementation((deps, reason) => {
    applies.push(reason);
    return ipAccess.readIpAccessApplied(deps);
  });
});
afterEach(() => {
  apply.mockRestore();
  panel.close();
});

type Info = MessageInitShape<typeof TailscaleInfoSchema>;

function running(overrides: Record<string, unknown> = {}): Info {
  return {
    version: "1.104.5",
    backendState: "Running",
    tailnet: "example.com",
    dnsName: `${dnsName}.`,
    addresses: ["100.101.42.7"],
    magicDns: true,
    https: true,
    loginName: "owner@example.com",
    serve: { state: TailnetServeState.ACTIVE, url: `https://${dnsName}`, panelAnswers: true, proxy: "unix:/x/tailnet.sock" },
    ...overrides,
  } as Info;
}

const facts = (info: Info | null, capabilities = [tailnetServeCapability]) =>
  create(NodeFactsSchema, { hostname: "panel-1", capabilities, ...(info ? { tailscale: info } : {}) });

const report = (info: Info | null, at: number) => recordReport(panel.deps, facts(info), at);
const working = (at: number) => tailnetPathState(panel.deps, at).working;
const openAlerts = (prefix: string) =>
  panel.deps.db
    .select()
    .from(alerts)
    .where(isNull(alerts.resolvedAt))
    .all()
    .filter((a) => a.eventKey.startsWith(prefix));

test("without Serve wanted the tailnet is no path, whatever the server reports", () => {
  report(running(), t0);
  expect(working(t0)).toBe(false);
  expect(listPrivatePaths(panel.deps)).toEqual([]);
  expect(applies).toEqual([]);
});

test("a working report makes the path work at once; it stops after 5 minutes of reports that do not", () => {
  setSetting(panel.deps.db, "tailscaleServe", true);
  report(running(), t0);
  expect(working(t0)).toBe(true);
  expect(applies).toEqual(["the tailnet works"]);
  expect(listPrivatePaths(panel.deps)).toEqual([
    { kind: "tailnet", url: `https://${dnsName}`, working: true, since: new Date(t0).toISOString(), usingNow: false },
  ]);

  // tailscaled stopped: still working for 5 minutes.
  report(running({ backendState: "Stopped", serve: { state: TailnetServeState.OFF } }), t0 + minute);
  expect(working(t0 + minute)).toBe(true);
  expect(working(t0 + minute + tailnetDownMs - 1)).toBe(true);
  // Read time already sees the end of the debounce; the 1-minute job records it.
  expect(working(t0 + minute + tailnetDownMs)).toBe(false);
  settle(panel.deps, t0 + minute + tailnetDownMs);
  expect(getSetting(panel.deps.db, "tailscaleSeen")).toMatchObject({
    working: false,
    stoppedAt: t0 + minute + tailnetDownMs,
    downSince: null,
  });
  expect(applies).toEqual(["the tailnet works", "the tailnet stopped working"]);
  expect(openAlerts("tailnet-stopped:")).toHaveLength(1);

  // Back: works at once, the alert is resolved.
  report(running(), t0 + 10 * minute);
  expect(working(t0 + 10 * minute)).toBe(true);
  expect(openAlerts("tailnet-stopped:")).toHaveLength(0);
  expect(panel.deps.db.select().from(alerts).where(eq(alerts.event, "health_recovered")).all()).toHaveLength(1);
});

test("a short blip does not count, and the panel not answering through the socket is not working", () => {
  setSetting(panel.deps.db, "tailscaleServe", true);
  report(running(), t0);
  report(running({ serve: { state: TailnetServeState.ACTIVE, url: `https://${dnsName}`, panelAnswers: false } }), t0 + minute);
  report(running(), t0 + 3 * minute);
  settle(panel.deps, t0 + 20 * minute);
  expect(working(t0 + 20 * minute)).toBe(true);
  expect(applies).toEqual(["the tailnet works"]);
});

test("an offline agent flips nothing, and a reconnect starts the 5 minutes again", () => {
  setSetting(panel.deps.db, "tailscaleServe", true);
  report(running(), t0);
  report(null, t0 + minute); // no tailscaled socket
  online = false;
  settle(panel.deps, t0 + 30 * minute);
  expect(working(t0 + 30 * minute)).toBe(true);
  agentDisconnected(panel.deps);
  // Back online: the hello says the same, the clock starts now.
  online = true;
  report(null, t0 + 31 * minute);
  expect(working(t0 + 31 * minute + tailnetDownMs - 1)).toBe(true);
  settle(panel.deps, t0 + 31 * minute + tailnetDownMs);
  expect(working(t0 + 31 * minute + tailnetDownMs)).toBe(false);
});

test("reports from an agent that does not read Tailscale are no reports", () => {
  setSetting(panel.deps.db, "tailscaleServe", true);
  report(running(), t0);
  recordReport(panel.deps, facts(null, []), t0 + minute);
  settle(panel.deps, t0 + 30 * minute);
  expect(working(t0 + 30 * minute)).toBe(true);
});

test("turning Serve off stops the path at once, without the grace period", () => {
  setSetting(panel.deps.db, "tailscaleServe", true);
  report(running(), t0);
  setSetting(panel.deps.db, "tailscaleServe", false);
  serveTurnedOff(panel.deps, t0 + minute);
  expect(getSetting(panel.deps.db, "tailscaleSeen")?.working).toBe(false);
  expect(anyPrivatePathWorking(panel.deps)).toBe(false);
  // setServe asks applyPanelIpAccess itself; no stopped alert for an owner's choice.
  expect(applies).toEqual(["the tailnet works"]);
  expect(openAlerts("tailnet-stopped:")).toHaveLength(0);
});

test("Serve stays on its tailnet: a report from another one stops the path at once, a DNS rename does not", () => {
  setSetting(panel.deps.db, "tailscaleServe", true);
  setSetting(panel.deps.db, "tailscaleServeTailnet", { tailnet: "example.com", dnsName });
  const dirty = spyOn(panel.deps.agents.desired, "markDirty");
  const active = (name: string) => ({ state: TailnetServeState.ACTIVE, url: `https://${name}`, panelAnswers: true });
  report(running(), t0);
  expect(working(t0)).toBe(true);

  // The tailnet's DNS name was renamed: the same tailnet, still working.
  const renamed = "panel.cat-crocodile.ts.net";
  report(running({ dnsName: `${renamed}.`, serve: active(renamed) }), t0 + minute);
  expect(working(t0 + minute)).toBe(true);
  expect(dirty).not.toHaveBeenCalled();

  // Signed in to another tailnet, where the agent already moved its entry and the panel answers.
  const other = "panel.tail9999.ts.net";
  report(running({ tailnet: "work.example", dnsName: `${other}.`, serve: active(other) }), t0 + 2 * minute);
  expect(working(t0 + 2 * minute)).toBe(false);
  expect(getSetting(panel.deps.db, "tailscaleSeen")).toMatchObject({ reported: false, working: false, stoppedAt: t0 + 2 * minute });
  expect(applies).toEqual(["the tailnet works", "the panel server is on another tailnet"]);
  // The desired state drops tailnet.panel, so the agent removes the entry.
  expect(dirty).toHaveBeenCalledTimes(1);
  // Listed under the address Serve was turned on for, not working.
  expect(listPrivatePaths(panel.deps)).toEqual([
    { kind: "tailnet", url: `https://${dnsName}`, working: false, since: new Date(t0 + 2 * minute).toISOString(), usingNow: false },
  ]);
  const moved = openAlerts("tailnet-moved:");
  expect(moved).toHaveLength(1);
  expect(moved[0]?.event).toBe("security_change");
  expect(moved[0]?.title).toBe("Tailscale on panel-1 moved from the tailnet example.com to work.example");
  expect(openAlerts("tailnet-stopped:")).toHaveLength(0);
  // Five minutes later nothing has changed: still not working, still one alert.
  report(running({ tailnet: "work.example", dnsName: `${other}.`, serve: active(other) }), t0 + 9 * minute);
  settle(panel.deps, t0 + 9 * minute);
  expect(working(t0 + 9 * minute)).toBe(false);
  expect(openAlerts("tailnet-moved:")).toHaveLength(1);
  expect(dirty).toHaveBeenCalledTimes(1);

  // Back on example.com: working again, the alert resolved, the entry asked for again.
  report(running(), t0 + 10 * minute);
  expect(working(t0 + 10 * minute)).toBe(true);
  expect(openAlerts("tailnet-moved:")).toHaveLength(0);
  expect(dirty).toHaveBeenCalledTimes(2);
  dirty.mockRestore();
});

test("another tailnet is told by name, by MagicDNS suffix when a name is missing, and a signed-out server is on none", () => {
  const approved = { tailnet: "example.com", dnsName };
  expect(onOtherTailnet(null, "work.example", "panel.tail9999.ts.net")).toBe(false);
  expect(onOtherTailnet(approved, "example.com", "panel.cat-crocodile.ts.net")).toBe(false);
  expect(onOtherTailnet(approved, "work.example", dnsName)).toBe(true);
  expect(onOtherTailnet(approved, "", "")).toBe(false);
  const unnamed = { tailnet: "", dnsName };
  expect(onOtherTailnet(unnamed, "", "panel.tail9999.ts.net")).toBe(true);
  expect(onOtherTailnet(unnamed, "example.com", "seylo.tail1234.ts.net")).toBe(false);
});

test("Serve on without a recorded tailnet (an early 0.2.1 build): the first Running report pins it", () => {
  setSetting(panel.deps.db, "tailscaleServe", true);
  report(running({ backendState: "NeedsLogin", tailnet: "", dnsName: "", serve: { state: TailnetServeState.OFF } }), t0);
  expect(getSetting(panel.deps.db, "tailscaleServeTailnet")).toBeUndefined();
  report(running(), t0 + minute);
  expect(getSetting(panel.deps.db, "tailscaleServeTailnet")).toEqual({ tailnet: "example.com", dnsName });
  report(running({ tailnet: "work.example" }), t0 + 2 * minute);
  expect(working(t0 + 2 * minute)).toBe(false);
});

test("the stopped alert says whether IP access reopened or stays closed", () => {
  setSetting(panel.deps.db, "tailscaleServe", true);
  const closed = { closed: true, agentPortClosed: false, at: t0, reason: "test" };
  setSetting(panel.deps.db, "panelIpAccessApplied", closed);
  report(running(), t0);
  // Reopen mode: F2b opens IP access when no path works.
  apply.mockImplementation((deps, reason) => {
    applies.push(reason);
    const open = { closed: false, agentPortClosed: false, at: t0, reason };
    setSetting(deps.db, "panelIpAccessApplied", open);
    return open;
  });
  report(null, t0 + minute);
  settle(panel.deps, t0 + minute + tailnetDownMs);
  expect(openAlerts("tailnet-stopped:")[0]?.message).toContain("IP access reopened");

  // Keep it closed.
  report(running(), t0 + 20 * minute);
  setSetting(panel.deps.db, "panelIpAccessApplied", closed);
  apply.mockImplementation((deps, reason) => {
    applies.push(reason);
    return ipAccess.readIpAccessApplied(deps);
  });
  report(null, t0 + 21 * minute);
  settle(panel.deps, t0 + 21 * minute + tailnetDownMs);
  expect(openAlerts("tailnet-stopped:")[0]?.message).toContain("IP access stays closed");
});

test("key expiry within 14 days, needs login and needs approval alert while Serve is wanted, and resolve", () => {
  const soon = t0 + 10 * 86_400_000;
  report(running({ keyExpiry: timestampFromMs(soon) }), t0);
  expect(openAlerts("tailnet-key-expiry:")).toHaveLength(0);

  setSetting(panel.deps.db, "tailscaleServe", true);
  report(running({ keyExpiry: timestampFromMs(soon) }), t0);
  const expiry = openAlerts("tailnet-key-expiry:");
  expect(expiry).toHaveLength(1);
  expect(expiry[0]?.title).toContain("expires on 2026-11-18");
  // Same expiry: no second alert. A renewed key resolves it.
  report(running({ keyExpiry: timestampFromMs(soon) }), t0 + minute);
  expect(openAlerts("tailnet-key-expiry:")).toHaveLength(1);
  report(running({ keyExpiry: timestampFromMs(t0 + 180 * 86_400_000) }), t0 + 2 * minute);
  expect(openAlerts("tailnet-key-expiry:")).toHaveLength(0);
  // Key expiry disabled: nothing.
  report(running(), t0 + 3 * minute);
  expect(openAlerts("tailnet-key-expiry:")).toHaveLength(0);

  report(running({ backendState: "NeedsLogin", serve: { state: TailnetServeState.OFF } }), t0 + 4 * minute);
  expect(openAlerts("tailnet-needs-login:")).toHaveLength(1);
  report(running({ backendState: "NeedsLogin", serve: { state: TailnetServeState.OFF } }), t0 + 5 * minute);
  expect(openAlerts("tailnet-needs-login:")).toHaveLength(1);
  report(running({ backendState: "NeedsMachineAuth", serve: { state: TailnetServeState.OFF } }), t0 + 6 * minute);
  expect(openAlerts("tailnet-needs-login:")).toHaveLength(0);
  expect(openAlerts("tailnet-needs-approval:")).toHaveLength(1);
  report(running(), t0 + 7 * minute);
  expect(openAlerts("tailnet-needs-")).toHaveLength(0);
  expect(
    panel.deps.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.event, "node_health_check_failed")))
      .all()
      .every((a) => a.link === "/settings/tailscale"),
  ).toBe(true);
});
