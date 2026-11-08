// Add node's "Build images on this node" (added in 0.2.1) with the demo data
// (demo/*.ts): the box is ticked by default, the join command request
// carries the choice, and the command on screen says what it makes. To
// change it, Change revokes that command and shows the box again. The ops
// are answered in the browser; the panel's own tests (node-ops,
// agent-hub) cover what the server stores and the handshake.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, unknown>;
const shots = `${process.env.SHOTS_DIR ?? "shots"}/nodes-build-default`;
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

test.describe("Add node: build images by default", () => {
  test.use({ storageState: stateFile });

  test("the box is ticked by default and the command says the node builds", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installDemo(page);
    const sent = recordOps(page);
    await page.goto("/nodes");
    const card = page.getByRole("region", { name: "Add a node" });
    const box = card.getByRole("checkbox", { name: "Build images on this node", exact: true });
    await expect(box).toBeChecked();
    await expect(box).toHaveAccessibleDescription(/Untick for servers you do not fully trust\./);
    await expect(card.getByText("The command installs Docker when the server has none.")).toBeVisible();

    await card.getByRole("button", { name: "Create join command" }).click();
    await expect(card.getByText(/Single use · expires in/)).toBeVisible();
    await expect(card.getByText("The node that joins builds images.")).toBeVisible();
    await expect(box).toHaveCount(0);
    await page.screenshot({ path: `${shots}/ticked.png` });
    expect(sent["nodes.createJoinToken"]).toEqual([{ canBuild: true }]);
    expect(errors).toEqual([]);
  });

  test("unticking sends canBuild false; Change revokes the command and asks again", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installDemo(page, { overrides: { "nodes.revokeJoinToken": () => ({}) } });
    const sent = recordOps(page);
    await page.goto("/nodes");
    const card = page.getByRole("region", { name: "Add a node" });
    const box = card.getByRole("checkbox", { name: "Build images on this node", exact: true });

    await box.click();
    await expect(box).not.toBeChecked();
    await card.getByRole("button", { name: "Create join command" }).click();
    await expect(card.getByText("The node that joins does not build images.")).toBeVisible();
    await page.screenshot({ path: `${shots}/unticked.png` });
    expect(sent["nodes.createJoinToken"]).toEqual([{ canBuild: false }]);

    // Change: the command on screen stops working, and the box comes back as it was left.
    await card.getByRole("button", { name: "Change", exact: true }).click();
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
    expect(sent["nodes.revokeJoinToken"]).toEqual([{ tokenId: "token00000000001" }]);
    await expect(card.getByText(/Single use · expires in/)).toHaveCount(0);

    await box.click();
    await card.getByRole("button", { name: "Create join command" }).click();
    await expect(card.getByText("The node that joins builds images.")).toBeVisible();
    expect(sent["nodes.createJoinToken"]).toEqual([{ canBuild: false }, { canBuild: true }]);
    expect(errors).toEqual([]);
  });

  test("Add node in the page header creates the command with the box's value", async ({ page }) => {
    await installDemo(page);
    const sent = recordOps(page);
    await page.goto("/nodes");
    await page.getByRole("button", { name: "Add node", exact: true }).click();
    const card = page.getByRole("region", { name: "Add a node" });
    await expect(card.getByText("The node that joins builds images.")).toBeVisible();
    expect(sent["nodes.createJoinToken"]).toEqual([{ canBuild: true }]);
  });
});
