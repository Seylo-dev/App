// The node sheet's Machine card follows the agent's own check for a newer
// Docker Engine (the node's docker, added in 0.2.5), with the demo data
// (demo/fixtures.ts): us-ash-1 has Docker 29.0.2 available, de-fsn-1 has
// nothing newer, il-tlv-1's older agent reports nothing. A newer version
// turns the Docker version amber with a question mark whose tooltip names
// it (also from the keyboard), and Update Docker keeps its own dry run;
// nothing newer leaves the version as it was and turns Update Docker off
// with why. The ops are answered in the browser; the panel's own tests
// (docker-check) cover what the server stores.

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, unknown>;
const shots = `${process.env.SHOTS_DIR ?? "shots"}/docker-check`;
mkdirSync(shots, { recursive: true });
const availableTip = "Docker 29.0.2 is available. Update it from this node's actions.";

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

/** The node sheet's overview, settled: the Machine card and the Docker row. */
async function openOverview(page: Page, nodeId: string) {
  await page.goto(`/nodes?node=${nodeId}&view=overview`);
  const sheet = page.getByRole("dialog").first();
  const machine = sheet.getByRole("region", { name: "Machine" });
  await expect(machine.getByText("Hostname")).toBeVisible();
  await expect(sheet.locator('[data-slot="skeleton"]')).toHaveCount(0);
  const docker = machine.locator("dd").filter({ has: page.getByText("29.0.1", { exact: true }) });
  return { sheet, machine, docker, update: sheet.getByRole("button", { name: "Update Docker" }) };
}

const colorOf = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).color);

test.describe("Docker version check", () => {
  test.use({ storageState: stateFile });

  test("a newer Docker: amber version with a question mark, Update Docker runs its own dry run", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installDemo(page, {
      overrides: { "nodes.updateDocker": () => ({ fromVersion: "29.0.1", toVersion: "29.0.2", runId: null, warning: "" }) },
    });
    const sent = recordOps(page);
    const { machine, docker, update } = await openOverview(page, ids.us);

    const help = machine.getByRole("button", { name: availableTip });
    await expect(help).toBeVisible();
    // The amber of warnings, not the card's text color.
    const hostname = machine.locator("dd").first();
    expect(await colorOf(docker.locator("[data-docker-update]"))).not.toBe(await colorOf(hostname));
    await expect(docker.locator("[data-docker-update]")).toHaveClass(/text-chip-amber-fg/);

    await machine.screenshot({ path: `${shots}/machine-update-available.png` });
    // The keyboard reaches the question mark and its tooltip.
    await help.focus();
    await expect(page.getByRole("tooltip")).toHaveText(availableTip);
    await expect(page.locator('[data-slot="tooltip"]')).toHaveCSS("opacity", "1");
    const box = await machine.boundingBox();
    // The tooltip is centred on the question mark, so it reaches left of the card.
    if (box) await page.screenshot({ path: `${shots}/machine-tooltip.png`, clip: { x: box.x - 110, y: box.y - 8, width: box.width + 120, height: box.height + 16 } });
    await help.blur();

    await expect(update).toBeEnabled();
    await expect(update).not.toHaveAttribute("title");
    await update.click();
    const confirm = page.getByRole("alertdialog", { name: "Update Docker?" });
    await expect(confirm.getByText("Docker goes from 29.0.1 to 29.0.2.", { exact: false })).toBeVisible();
    expect(sent["nodes.updateDocker"]).toEqual([{ nodeId: ids.us, dryRun: true }]);
    await expect(confirm).toHaveCSS("opacity", "1");
    await page.screenshot({ path: `${shots}/confirm.png` });
    expect(errors).toEqual([]);
  });

  test("nothing newer: the version as before, Update Docker off with why", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installDemo(page);
    const sent = recordOps(page);
    const { machine, docker, update } = await openOverview(page, ids.de);

    await expect(docker).toHaveText("29.0.1");
    await expect(machine.getByRole("button")).toHaveCount(0);
    await expect(docker.locator("[data-docker-update]")).toHaveCount(0);
    await expect(update).toBeDisabled();
    await expect(update).toHaveAttribute("title", "Docker is up to date (29.0.1, checked 2 h ago)");
    await machine.screenshot({ path: `${shots}/machine-up-to-date.png` });
    expect(sent["nodes.updateDocker"]).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test("an older agent that reports nothing: as before, Update Docker on", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installDemo(page);
    const { machine, docker, update } = await openOverview(page, ids.il);
    await expect(docker).toHaveText("29.0.1");
    await expect(machine.getByRole("button")).toHaveCount(0);
    await expect(update).toBeEnabled();
    await expect(update).not.toHaveAttribute("title");
    expect(errors).toEqual([]);
  });
});
