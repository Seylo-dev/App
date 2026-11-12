// A node's "Builds at once" with the demo data: Auto or a fixed number
// from 1 to 16. Auto shows what it works out to on the node now (one build
// per 4 cores and 4 GB of memory, up to 16), Save sends Auto without a
// number and a number alone, and the panel's answer is what the form shows
// after. The ops are answered in the browser; the panel's own tests
// (parallel-builds) cover what it stores and sends to the agent.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids, nodeDetail } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, unknown>;
// il-tlv-1: 16 cores and 64 GB, so Auto is 4; the demo data has it fixed at 2.
const node = ids.il;
const shots = `${process.env.SHOTS_DIR ?? "shots"}/node-builds-auto`;
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

/** The panel's answers for this node: it keeps what updateSettings asked for, with Auto worked out. */
async function demo(page: Page, start: { parallelBuildsAuto: boolean; maxParallelBuilds: number }) {
  let saved = start;
  await installDemo(page, {
    overrides: {
      "nodes.get": (input) => ({ ...nodeDetail(String(input.nodeId ?? "")), ...saved }),
      "nodes.updateSettings": (input) => {
        if (input.parallelBuildsAuto === true) saved = { parallelBuildsAuto: true, maxParallelBuilds: 4 };
        else if (typeof input.maxParallelBuilds === "number") saved = { parallelBuildsAuto: false, maxParallelBuilds: input.maxParallelBuilds };
        return { ...nodeDetail(node), ...saved };
      },
    },
  });
}

test.describe("node builds at once", () => {
  test.use({ storageState: stateFile });

  test("a fixed number goes to Auto, which says what it runs now", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await demo(page, { parallelBuildsAuto: false, maxParallelBuilds: 2 });
    const sent = recordOps(page);
    await page.goto(`/nodes?node=${node}&view=settings`);
    const sheet = page.getByRole("dialog");
    const field = sheet.getByRole("combobox", { name: "Builds at once" });
    await expect(field).toHaveText("2");
    await expect(sheet.getByText("1 per 4 cores and 4 GB of memory, up to 16.")).toHaveCount(0);

    await field.click();
    const choices = page.getByRole("option");
    await expect(choices).toHaveCount(17);
    await expect(choices.first()).toHaveText("Auto - 4 now");
    await expect(choices.last()).toHaveText("16");
    await page.screenshot({ path: `${shots}/choices.png` });
    await choices.first().click();
    await expect(field).toHaveText("Auto - 4 now");
    await expect(field).toHaveAccessibleDescription("1 per 4 cores and 4 GB of memory, up to 16.");

    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Node saved.")).toBeVisible();
    const saved = sent["nodes.updateSettings"]?.[0];
    expect(saved).toMatchObject({ nodeId: node, parallelBuildsAuto: true });
    expect(saved).not.toHaveProperty("maxParallelBuilds");
    await expect(field).toHaveText("Auto - 4 now");
    await sheet.screenshot({ path: `${shots}/auto.png` });
    expect(errors).toEqual([]);
  });

  test("Auto goes to a fixed number, sent alone", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await demo(page, { parallelBuildsAuto: true, maxParallelBuilds: 4 });
    const sent = recordOps(page);
    await page.goto(`/nodes?node=${node}&view=settings`);
    const sheet = page.getByRole("dialog");
    const field = sheet.getByRole("combobox", { name: "Builds at once" });
    await expect(field).toHaveText("Auto - 4 now");
    await expect(sheet.getByText("1 per 4 cores and 4 GB of memory, up to 16.")).toBeVisible();

    await field.click();
    await page.getByRole("option", { name: "6", exact: true }).click();
    await expect(field).toHaveText("6");
    await expect(sheet.getByText("1 per 4 cores and 4 GB of memory, up to 16.")).toHaveCount(0);
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Node saved.")).toBeVisible();
    const saved = sent["nodes.updateSettings"]?.[0];
    expect(saved).toMatchObject({ nodeId: node, maxParallelBuilds: 6 });
    expect(saved).not.toHaveProperty("parallelBuildsAuto");
    expect(errors).toEqual([]);
  });
});
