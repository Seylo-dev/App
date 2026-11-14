// A node's DNS cache for containers in its settings, with the demo data
// (0.2.17): the switch turns it on (nodes.setDnsCache), the status shows
// Starting, then Active with the address, hit rate, upstream lookups per
// minute and the containers that use it and those waiting for a redeploy;
// Blocked shows what to fix with the ufw command; turned off it drains;
// an agent before 0.2.17 gets a disabled switch that says what it needs,
// and next to Wings it says game servers take DNS from Wings. The ops are
// answered in the browser; the panel's own tests (node-dns-cache) cover
// what it stores and sends to the agent.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { dnsCacheStatus, ids, nodeDetail } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, unknown>;
const node = ids.de;
const shots = `${process.env.SHOTS_DIR ?? "shots"}/dns-cache`;
mkdirSync(shots, { recursive: true });

function recordOps(page: Page) {
  const sent: Record<string, Input[]> = {};
  page.on("request", (request) => {
    const match = /\/api\/v1\/([a-zA-Z]+\.[a-zA-Z]+)/.exec(request.url());
    if (!match || request.method() !== "POST") return;
    (sent[match[1] as string] ??= []).push((request.postDataJSON() as Input | null) ?? {});
  });
  return sent;
}

const containers = [
  { name: "seylo-svcweb000000001a-7", serviceId: ids.web, serviceName: "web", kind: "service", usesCache: true, created: null },
  { name: "seylo-svcapi000000002a-3", serviceId: ids.api, serviceName: "api", kind: "service", usesCache: false, created: null },
  { name: "seylo-cron-svcworker0000005-1", serviceId: null, serviceName: null, kind: "cron", usesCache: false, created: null },
];

/** The demo node with the cache's setting and status a test moves through. */
async function demo(page: Page, start: { enabled: boolean; state: string; supported?: boolean; extra?: Record<string, unknown> }) {
  let enabled = start.enabled;
  let state = start.state;
  let extra = start.extra ?? {};
  const supported = start.supported ?? true;
  await installDemo(page, {
    overrides: {
      "nodes.get": (input) => ({ ...nodeDetail(String(input.nodeId ?? "")), dnsCache: enabled, dnsCacheSupported: supported }),
      "nodes.setDnsCache": (input) => {
        enabled = input.enabled === true;
        // The agent tests from inside a container first, then hands it out.
        state = enabled ? "starting" : "draining";
        return { ...nodeDetail(node), dnsCache: enabled };
      },
      "nodes.dnsCacheStatus": (input) => ({
        ...dnsCacheStatus(String(input.nodeId ?? "")),
        enabled,
        supported,
        state,
        ...(state === "off" ? {} : { containers, entries: 140, queries: 5200, hits: 4790, hitRate: 4790 / 5200, upstreamQueries: 410, upstreamPerMinute: 3.2 }),
        ...extra,
      }),
    },
  });
  return {
    setState(next: string, more: Record<string, unknown> = {}) {
      state = next;
      extra = more;
    },
  };
}

test.describe("node DNS cache", () => {
  test.use({ storageState: stateFile });

  test("turned on, it starts, then shows what uses it and what waits for a redeploy", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const world = await demo(page, { enabled: false, state: "off" });
    const sent = recordOps(page);
    await page.goto(`/nodes?node=${node}&view=settings`);
    const sheet = page.getByRole("dialog");
    const toggle = sheet.getByRole("switch", { name: "DNS cache for containers" });
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    await expect(sheet.getByText("It does not help with many different names, and it is no limit")).toBeVisible();
    await expect(sheet.getByTestId("dns-cache-state")).toHaveCount(0);
    await sheet.getByTestId("dns-cache").screenshot({ path: `${shots}/off.png` });

    await toggle.click();
    await expect(page.getByText("Node saved.")).toBeVisible();
    expect(sent["nodes.setDnsCache"]?.[0]).toEqual({ nodeId: node, enabled: true });
    await expect(toggle).toBeChecked();
    await expect(sheet.getByTestId("dns-cache-state")).toHaveText("Starting");
    await expect(sheet.getByText("Testing the cache from inside a container before new containers get it.")).toBeVisible();

    world.setState("active");
    await page.reload();
    const panel = page.getByRole("dialog").getByTestId("dns-cache");
    await expect(panel.getByTestId("dns-cache-state")).toHaveText("Active");
    await expect(panel.getByText("169.254.53.53", { exact: true })).toBeVisible();
    await expect(panel.getByTestId("dns-cache-hit-rate")).toHaveText("92%");
    await expect(panel.getByTestId("dns-cache-upstream")).toHaveText("3.2");
    const using = panel.getByRole("region", { name: "Using the cache" });
    await expect(using.getByRole("link", { name: "web" })).toBeVisible();
    const waiting = panel.getByRole("region", { name: "Not yet - redeploy to apply" });
    await expect(waiting.getByRole("listitem")).toHaveCount(2);
    await expect(waiting.getByText("Cron run")).toBeVisible();
    await expect(panel.getByText("redeploy a service to apply it. Nothing restarts on its own.")).toBeVisible();
    await panel.screenshot({ path: `${shots}/active.png` });
    expect(errors).toEqual([]);
  });

  test("blocked by a firewall: the reason and the ufw command", async ({ page }) => {
    await demo(page, {
      enabled: true,
      state: "blocked",
      extra: {
        reason: "a test container on seylo-p-projacmeshop0001 gets no answer from it (;; connection timed out; no servers could be reached)",
        fixHint:
          'A firewall on the node probably drops DNS from containers to 169.254.53.53. With ufw: `ufw allow to 169.254.53.53 port 53 comment "seylo dns"`. Then run the health check again; until it passes, new containers do not get the cache.',
        checkPassed: false,
      },
    });
    await page.goto(`/nodes?node=${node}&view=settings`);
    const panel = page.getByRole("dialog").getByTestId("dns-cache");
    await expect(panel.getByTestId("dns-cache-state")).toHaveText("Blocked");
    await expect(panel.getByText("gets no answer from it")).toBeVisible();
    await expect(panel.locator("code", { hasText: 'ufw allow to 169.254.53.53 port 53 comment "seylo dns"' })).toBeVisible();
    await panel.screenshot({ path: `${shots}/blocked.png` });
  });

  test("turned off while containers use it: it drains", async ({ page }) => {
    const sent = recordOps(page);
    await demo(page, { enabled: true, state: "active" });
    await page.goto(`/nodes?node=${node}&view=settings`);
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("switch", { name: "DNS cache for containers" }).click();
    await expect(page.getByText("Node saved.")).toBeVisible();
    expect(sent["nodes.setDnsCache"]?.[0]).toEqual({ nodeId: node, enabled: false });
    const panel = sheet.getByTestId("dns-cache");
    await expect(panel.getByTestId("dns-cache-state")).toHaveText("Off, still in use");
    await expect(panel.getByRole("region", { name: "Still using the cache" })).toBeVisible();
    await expect(panel.getByRole("region", { name: "Not yet - redeploy to apply" })).toHaveCount(0);
    await panel.screenshot({ path: `${shots}/draining.png` });
  });

  test("an agent before 0.2.17: the switch is disabled and says what it needs", async ({ page }) => {
    const sent = recordOps(page);
    await demo(page, { enabled: false, state: "unknown", supported: false });
    await page.goto(`/nodes?node=${node}&view=settings`);
    const panel = page.getByRole("dialog").getByTestId("dns-cache");
    await expect(panel.getByRole("switch", { name: "DNS cache for containers" })).toBeDisabled();
    await expect(panel.getByText("The DNS cache needs the node's agent 0.2.17 or later. Update the node first.")).toBeVisible();
    await panel.screenshot({ path: `${shots}/old-agent.png` });
    expect(sent["nodes.dnsCacheStatus"] ?? []).toEqual([]);
  });

  test("next to Wings it says game servers take DNS from Wings", async ({ page }) => {
    await demo(page, { enabled: false, state: "off" });
    await page.goto(`/nodes?node=${ids.il}&view=settings`);
    await expect(page.getByRole("dialog").getByText("Wings game servers take their DNS from Wings' own config (docker.network.dns)")).toBeVisible();
  });
});
