// A node's Panel address and why an offline node is offline, with the demo
// data. Settings: a node the panel keeps on its address because a move
// alert says its network re-signed the domain's certificate shows "Stay on
// this address" with that reason; choosing "Follow the panel's domain"
// sends nodes.updateSettings with panelAddressChoice "follow" and the
// answer (chosen by the owner) drops the reason. The node list: an offline
// node whose agent the panel refused says so under its badges, another
// says when it was last seen. The node's page: "Was offline from ... to
// ...: <reason>" from its agent's report. The ops are answered in the
// browser; the panel's own tests (panel-address) cover what it stores.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids, nodeDetail, nodes } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, unknown>;
const node = ids.il;
const shots = `${process.env.SHOTS_DIR ?? "shots"}/node-address`;
mkdirSync(shots, { recursive: true });

/** Op requests the page sent, by op id. */
function recordOps(page: Page) {
  const sent: Record<string, Input[]> = {};
  page.on("request", (request) => {
    const match = /\/api\/v1\/([a-zA-Z]+\.[a-zA-Z]+)/.exec(request.url());
    if (!match || request.method() !== "POST") return;
    const id = match[1] as string;
    (sent[id] ??= []).push((request.postDataJSON() as Input | null) ?? {});
  });
  return sent;
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

test.describe("node panel address", () => {
  test.use({ storageState: stateFile });

  test("a node kept on its address by an alert can follow the domain again", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let choice = { panelAddressChoice: "stay", panelAddressChoiceBy: "inspectedCertificate", panelAddressChoiceAt: minutesAgo(20) };
    await installDemo(page, {
      overrides: {
        "nodes.get": (input) => ({ ...nodeDetail(String(input.nodeId ?? "")), ...choice }),
        "nodes.updateSettings": (input) => {
          choice = { panelAddressChoice: String(input.panelAddressChoice), panelAddressChoiceBy: "owner", panelAddressChoiceAt: minutesAgo(0) };
          return { ...nodeDetail(node), ...choice };
        },
      },
    });
    const sent = recordOps(page);
    await page.goto(`/nodes?node=${node}&view=settings`);
    const sheet = page.getByRole("dialog");
    const group = sheet.getByRole("radiogroup", { name: "Panel address" });
    await expect(group.getByRole("radio", { name: /Stay on this address/ })).toBeChecked();
    await expect(sheet.getByText(/Kept here because the node's network re-signed the panel domain's certificate/)).toBeVisible();
    await group.scrollIntoViewIfNeeded();
    await sheet.screenshot({ path: `${shots}/stay.png` });

    await group.getByRole("radio", { name: /Follow the panel's domain/ }).click();
    await expect(page.getByText("Node saved.")).toBeVisible();
    expect(sent["nodes.updateSettings"]?.[0]).toEqual({ nodeId: node, panelAddressChoice: "follow" });
    await expect(group.getByRole("radio", { name: /Follow the panel's domain/ })).toBeChecked();
    await expect(sheet.getByText(/Kept here because/)).toHaveCount(0);
    await sheet.screenshot({ path: `${shots}/follow.png` });
    expect(errors).toEqual([]);
  });

  test("the panel node has no Panel address", async ({ page }) => {
    await installDemo(page);
    await page.goto(`/nodes?node=${ids.de}&view=settings`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Can build", { exact: true })).toBeVisible();
    await expect(sheet.getByRole("radiogroup", { name: "Panel address" })).toHaveCount(0);
  });

  test("an offline node says why, and its page says how long it was away", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const list = nodes.map((n) =>
      n.id === node
        ? {
            ...n,
            status: "offline",
            usage: null,
            lastSeenAt: minutesAgo(30),
            rejectedHello: {
              reason: "AGENT_TOO_OLD",
              message: "This agent (0.2.1) is too old for this panel. It needs 0.2.5 or newer.",
              at: minutesAgo(4),
            },
          }
        : n.id === ids.us
          ? { ...n, status: "offline", usage: null, lastSeenAt: minutesAgo(12) }
          : n,
    );
    const from = Date.now() - 2 * 3_600_000;
    const lastOffline = {
      from: new Date(from).toISOString(),
      to: new Date(from + 7 * 60_000).toISOString(),
      reason: 'dial panel: x509: certificate signed by unknown authority (the certificate says it was issued by "Fortinet")',
      failedAttempts: 14,
    };
    await installDemo(page, {
      overrides: {
        "nodes.list": () => ({ nodes: list }),
        "nodes.get": (input) => ({ ...nodeDetail(String(input.nodeId ?? "")), ...(input.nodeId === ids.us ? { lastOffline } : {}) }),
      },
    });
    await page.goto("/nodes");
    const table = page.getByRole("region", { name: "Node list" });
    await expect(table.getByText("Refused 4 min ago: This agent (0.2.1) is too old for this panel. It needs 0.2.5 or newer.")).toBeVisible();
    await expect(table.getByText("Last seen 12 min ago")).toBeVisible();
    await table.screenshot({ path: `${shots}/offline-rows.png` });

    await page.goto(`/nodes?node=${ids.us}&view=overview`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText(/Was offline from .+ to .+: dial panel: x509: certificate signed by unknown authority/)).toBeVisible();
    await sheet.screenshot({ path: `${shots}/last-offline.png` });
    expect(errors).toEqual([]);
  });
});
