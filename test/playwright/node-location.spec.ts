// A node's Location detected from its public address, with the demo data:
// the Settings view shows it as the field's value, marked Detected with
// DB-IP's credit, until the form is saved; editing the field drops the mark,
// saving sends the location as it is, and the answer (locationSource
// "manual") keeps it off. The node list credits DB-IP under the list while
// a location in it was detected. The ops are answered in the browser; the
// panel's own tests (node-location) cover the lookup and what it stores.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids, nodeDetail, nodes } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, unknown>;
const node = ids.de;
const shots = `${process.env.SHOTS_DIR ?? "shots"}/node-location`;
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

test.describe("node location", () => {
  test.use({ storageState: stateFile });

  test("a detected location is marked until the form is saved", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let saved: { location: string | null; locationSource: "detected" | "manual" } = {
      location: "Falkenstein, Germany",
      locationSource: "detected",
    };
    await installDemo(page, {
      overrides: {
        "nodes.get": (input) => ({ ...nodeDetail(String(input.nodeId ?? "")), ...saved }),
        "nodes.updateSettings": (input) => {
          saved = { location: (input.location as string | null) ?? null, locationSource: "manual" };
          return { ...nodeDetail(node), ...saved };
        },
      },
    });
    const sent = recordOps(page);
    await page.goto(`/nodes?node=${node}&view=settings`);
    const sheet = page.getByRole("dialog");
    const field = sheet.getByLabel("Location", { exact: true });
    const chip = sheet.getByText("Detected", { exact: true });
    await expect(field).toHaveValue("Falkenstein, Germany");
    await expect(chip).toBeVisible();
    await expect(field).toHaveAccessibleDescription("From the server's IP address, Geolocation by DB-IP. Change it if it is wrong.");
    await expect(sheet.getByRole("link", { name: "Geolocation by DB-IP" })).toHaveAttribute("href", "https://db-ip.com");
    await sheet.screenshot({ path: `${shots}/detected.png` });

    // Editing drops the mark; back to the detected value, it is the suggestion again.
    await field.fill("Falkenstein, Saxony");
    await expect(chip).toHaveCount(0);
    await expect(sheet.getByRole("link", { name: "Geolocation by DB-IP" })).toHaveCount(0);
    await field.fill("Falkenstein, Germany");
    await expect(chip).toBeVisible();

    // Keeping it: saved as is, and it is the owner's from then on.
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Node saved.")).toBeVisible();
    expect(sent["nodes.updateSettings"]?.[0]).toMatchObject({ nodeId: node, location: "Falkenstein, Germany" });
    await expect(chip).toHaveCount(0);
    await expect(field).toHaveValue("Falkenstein, Germany");
    await sheet.screenshot({ path: `${shots}/saved.png` });
    expect(errors).toEqual([]);
  });

  test("the node list shows a detected location and credits DB-IP", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const detected = nodes.map((n) => (n.id === node ? { ...n, location: "Falkenstein, Germany", locationSource: "detected" } : n));
    await installDemo(page, { overrides: { "nodes.list": () => ({ nodes: detected }) } });
    await page.goto("/nodes");
    const list = page.getByRole("region", { name: "Node list" });
    await expect(list.getByText("Falkenstein, Germany")).toBeVisible();
    await expect(list.getByText("Detected locations:")).toBeVisible();
    await expect(list.getByRole("link", { name: "Geolocation by DB-IP" })).toHaveAttribute("href", "https://db-ip.com");
    await list.getByText("Falkenstein, Germany").hover();
    await expect(page.getByRole("tooltip")).toContainText("Detected from the server's IP address.");
    await page.screenshot({ path: `${shots}/list.png` });
    expect(errors).toEqual([]);
  });

  test("without a detected location the list credits nobody", async ({ page }) => {
    await installDemo(page);
    await page.goto("/nodes");
    await expect(page.getByRole("region", { name: "Node list" }).getByText("Ashburn, United States")).toBeVisible();
    await expect(page.getByText("Detected locations:")).toHaveCount(0);
  });
});
