// The private-path registry and the panel domain path (added in 0.2.1), and
// the WP0 stubs built on them: IP access stays open until WP-F2b, the
// panel access ops answer NOT_IMPLEMENTED, and tailscale.get reports
// Tailscale as not detected.

import { afterEach, expect, test } from "bun:test";
import { settings as settingOps, tailscale } from "@seylo/ops";
import { applyPanelIpAccess, readIpAccessApplied, readPanelAccessWanted } from "../src/modules/settings/ip-access";
import {
  anyPrivatePathWorking,
  domainPath,
  listPrivatePaths,
  type PrivatePathSource,
  privatePathSources,
  provingPrivatePath,
  registerPrivatePath,
} from "../src/modules/settings/private-paths";
import type { OpContext } from "../src/ops/implement";
import { setSetting } from "../src/settings";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel | undefined;
const registered: (() => void)[] = [];
afterEach(() => {
  panel?.close();
  for (const remove of registered.splice(0)) remove();
  registerPrivatePath(domainPath);
});

const ctxOf = (p: TestPanel, extra: Partial<OpContext>) => ({ ...p.deps, ...extra }) as OpContext;

function activeDomain(p: TestPanel, domain: string) {
  setSetting(p.deps.db, "panelDomain", domain);
  setSetting(p.deps.db, "panelDomainStatus", { domain, state: "active", message: "", checkedAt: Date.now() });
}

test("without a domain there is no private path", () => {
  panel = testPanel();
  expect(listPrivatePaths(panel.deps)).toEqual([]);
  expect(anyPrivatePathWorking(panel.deps)).toBe(false);
});

test("the domain works once its status is active for the current domain", () => {
  panel = testPanel();
  setSetting(panel.deps.db, "panelDomain", "panel.example.com");
  expect(listPrivatePaths(panel.deps)).toEqual([
    { kind: "domain", url: "https://panel.example.com", working: false, since: null, usingNow: false },
  ]);
  activeDomain(panel, "panel.example.com");
  expect(anyPrivatePathWorking(panel.deps)).toBe(true);
  // A status left over from another domain does not count.
  setSetting(panel.deps.db, "panelDomain", "new.example.com");
  expect(anyPrivatePathWorking(panel.deps)).toBe(false);
});

test("only an https://<domain> origin proves the domain path", () => {
  panel = testPanel();
  activeDomain(panel, "panel.example.com");
  const over = ctxOf(panel, { origin: "https://panel.example.com" });
  expect(provingPrivatePath(over)?.kind).toBe("domain");
  expect(listPrivatePaths(panel.deps, over)[0]?.usingNow).toBe(true);
  // IP:port is always http, even with a forged Host.
  for (const origin of ["http://panel.example.com", "http://203.0.113.5:3000", null]) {
    expect(provingPrivatePath(ctxOf(panel, { origin }))).toBeNull();
  }
});

test("a registered path joins the list after the domain, and one of the same kind replaces it", () => {
  panel = testPanel();
  const tailnet = (working: boolean): PrivatePathSource => ({
    kind: "tailnet",
    state: () => ({ url: "https://panel.tail1234.ts.net", working, since: new Date(0) }),
    provenBy: (ctx) => ctx.via === "tailnet",
  });
  registered.push(registerPrivatePath(tailnet(false)));
  registered.push(registerPrivatePath(tailnet(true)));
  expect(privatePathSources().map((s) => s.kind)).toEqual(["domain", "tailnet"]);
  expect(anyPrivatePathWorking(panel.deps)).toBe(true);
  expect(provingPrivatePath(ctxOf(panel, { via: "tailnet" }))?.kind).toBe("tailnet");
  expect(listPrivatePaths(panel.deps)).toEqual([
    { kind: "tailnet", url: "https://panel.tail1234.ts.net", working: true, since: new Date(0).toISOString(), usingNow: false },
  ]);
});

test("IP access stays open while it is not built", () => {
  panel = testPanel();
  activeDomain(panel, "panel.example.com");
  expect(readPanelAccessWanted(panel.deps)).toEqual({ serveOnIp: true, agentPortOpen: true, onFailure: "reopen" });
  expect(applyPanelIpAccess(panel.deps, "test")).toEqual({ closed: false, agentPortClosed: false, at: 0, reason: "" });
  expect(readIpAccessApplied(panel.deps).closed).toBe(false);
});

test("the panel access ops are routed but not built, and tailscale.get says not detected", async () => {
  panel = testPanel();
  const { cookie } = await createUser(panel, "owner");
  expect((await callOp(panel, settingOps.panelAccess, {}, { cookie })).status).toBe(501);
  expect((await callOp(panel, settingOps.updatePanelAccess, { serveOnIp: true }, { cookie })).status).toBe(501);
  for (const [op, input] of [
    [tailscale.setServe, { serve: true }],
    [tailscale.signIn, {}],
    [tailscale.setDns, { acceptDns: false }],
  ] as const) {
    expect((await callOp(panel, op, input as never, { cookie })).status).toBe(501);
  }
  const status = await callOp(panel, tailscale.get, {}, { cookie });
  expect(status.status).toBe(200);
  expect(status.body).toMatchObject({
    detected: false,
    agentOnline: false,
    agentSupported: false,
    minVersion: tailscale.minTailscaleVersion,
    serve: { wanted: false, state: "off", url: null },
    viaTailnet: false,
    canManage: true,
    installCommand: tailscale.tailscaleInstallCommand,
    signInUrl: null,
  });
});
