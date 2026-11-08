// The panel's public URL (links in alerts, the MCP URL): the domain, then
// SEYLO_PUBLIC_URL, then the tailnet URL while IP access is closed and the
// tailnet path works (added in 0.2.1), then IP:port.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { NodeFactsSchema, TailnetServeState } from "@seylo/proto";
import { nodes } from "../src/db/schema";
import * as ipAccess from "../src/modules/settings/ip-access";
import { panelIpUrl, panelLink, panelPublicUrl } from "../src/modules/settings/public-url";
import { tailnetServeCapability } from "../src/modules/tailscale/facts";
import { recordReport } from "../src/modules/tailscale/status";
import { setSetting } from "../src/settings";
import { type TestPanel, testPanel } from "./helpers";

const dnsName = "panel.tail1234.ts.net";
let panel: TestPanel;
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
  panel.deps.agents.isOnline = () => true;
  // IP access is what each test sets, not what WP-F2b would decide from it.
  apply = spyOn(ipAccess, "applyPanelIpAccess").mockImplementation((deps) => ipAccess.readIpAccessApplied(deps));
});
afterEach(() => {
  apply.mockRestore();
  panel.close();
});

function tailnetWorks() {
  setSetting(panel.deps.db, "tailscaleServe", true);
  recordReport(
    panel.deps,
    create(NodeFactsSchema, {
      capabilities: [tailnetServeCapability],
      tailscale: {
        backendState: "Running",
        dnsName,
        https: true,
        magicDns: true,
        serve: { state: TailnetServeState.ACTIVE, url: `https://${dnsName}`, panelAnswers: true },
      },
    }),
  );
}

const closeIpAccess = () =>
  setSetting(panel.deps.db, "panelIpAccessApplied", { closed: true, agentPortClosed: false, at: Date.now(), reason: "test" });

test("IP:port by default, with the host port", () => {
  const { deps } = panel;
  const ip = `http://203.0.113.10:${deps.config.hostPort ?? deps.config.port}`;
  expect(panelPublicUrl(deps)).toBe(ip);
  expect(panelIpUrl(deps)).toBe(ip);
  expect(panelLink(deps, "/settings/tailscale")).toBe(`${ip}/settings/tailscale`);
});

test("the tailnet URL only while IP access is closed and the tailnet works", () => {
  const { deps } = panel;
  tailnetWorks();
  // IP access open: IP:port still answers from outside, so it stays the address.
  expect(panelPublicUrl(deps)).toMatch(/^http:\/\/203\.0\.113\.10:/);
  closeIpAccess();
  expect(panelPublicUrl(deps)).toBe(`https://${dnsName}`);
  expect(panelLink(deps, "/settings")).toBe(`https://${dnsName}/settings`);
  // The IP:port URL itself does not change (setServe's reopenedUrl).
  expect(panelIpUrl(deps)).toMatch(/^http:\/\/203\.0\.113\.10:/);
  // Callers with only db and config never get the tailnet.
  expect(panelPublicUrl({ db: deps.db, config: deps.config })).toMatch(/^http:\/\/203\.0\.113\.10:/);
  // Serve turned off: no tailnet URL.
  setSetting(deps.db, "tailscaleServe", false);
  expect(panelPublicUrl(deps)).toMatch(/^http:\/\/203\.0\.113\.10:/);
});

test("the domain and SEYLO_PUBLIC_URL come before the tailnet", () => {
  const { deps } = panel;
  tailnetWorks();
  closeIpAccess();
  expect(panelPublicUrl({ ...deps, config: { ...deps.config, publicUrl: "https://panel.internal" } })).toBe("https://panel.internal");
  setSetting(deps.db, "panelDomain", "panel.example.com");
  expect(panelPublicUrl(deps)).toBe("https://panel.example.com");
});
