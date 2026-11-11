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
    // A re-join (Nodes > Add node with --force on a known node) keeps the node's own value.
    await expect(box).toHaveAccessibleDescription(/A node that joins again \(--force\) keeps its own Can build setting/);
    await expect(card.getByText("The command installs Docker when the server has none.")).toBeVisible();

    await card.getByRole("button", { name: "Create join command" }).click();
    await expect(card.getByText(/Single use · expires in/)).toBeVisible();
    await expect(card.getByText("A new node that joins builds images.")).toBeVisible();
    await expect(box).toHaveCount(0);
    await page.screenshot({ path: `${shots}/ticked.png` });
    expect(sent["nodes.createJoinToken"]).toEqual([{ canBuild: true }]);
    expect(errors).toEqual([]);
  });

  test("a domain command comes with the IP and pin command behind a toggle, for a network that decrypts HTTPS", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const token = "seylo_join_DomainAndPin01";
    const pin = `sha256:${"ab".repeat(32)}`;
    const pinnedCommand = `curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://203.0.113.10:3443' --token '${token}' --version '0.2.0' --pin '${pin}'`;
    await installDemo(page, {
      overrides: {
        "nodes.createJoinToken": () => ({
          tokenId: "token00000000002",
          token,
          command: `curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://panel.acme.dev' --token '${token}' --version '0.2.0'`,
          pinnedCommand,
          insecureTransport: false,
          expiresAt: new Date(Date.now() + 58 * 60_000).toISOString(),
          canBuild: true,
        }),
      },
    });
    await page.goto("/nodes");
    const card = page.getByRole("region", { name: "Add a node" });
    await card.getByRole("button", { name: "Create join command" }).click();
    const toggle = card.getByRole("button", { name: "Network decrypts HTTPS? Join over the panel's IP instead" });
    await expect(toggle).toBeVisible();
    await expect(card.getByText(pin, { exact: false })).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveCount(0);
    await expect(card.getByText(/a firewall doing TLS inspection; the agent refuses it/)).toBeVisible();
    await expect(card.getByText(/Run one command or the other: the token works once\./)).toBeVisible();
    await expect(card.getByLabel("Join command over the panel's IP")).toContainText("--pin");
    await page.screenshot({ path: `${shots}/pinned-command.png` });
    expect(errors).toEqual([]);
  });

  test("an IP command with the pin already shows no second command", async ({ page }) => {
    await installDemo(page);
    await page.goto("/nodes");
    const card = page.getByRole("region", { name: "Add a node" });
    await card.getByRole("button", { name: "Create join command" }).click();
    await expect(card.getByText(/Single use · expires in/)).toBeVisible();
    await expect(card.getByRole("button", { name: /Network decrypts HTTPS/ })).toHaveCount(0);
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
    await expect(card.getByText("A new node that joins does not build images.")).toBeVisible();
    await expect(card.getByText("A node that joins again keeps its own Can build setting: turn it off in the list above.")).toBeVisible();
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
    await expect(card.getByText("A new node that joins builds images.")).toBeVisible();
    expect(sent["nodes.createJoinToken"]).toEqual([{ canBuild: false }, { canBuild: true }]);
    expect(errors).toEqual([]);
  });

  test("a revoke that fails keeps the command on screen and says why", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installDemo(page);
    // The panel could not be reached: the token was not expired, so it still makes a build node.
    await page.route(/\/api\/v1\/nodes\.revokeJoinToken/, (route) => route.abort("connectionrefused"));
    const sent = recordOps(page);
    await page.goto("/nodes");
    const card = page.getByRole("region", { name: "Add a node" });
    await card.getByRole("button", { name: "Create join command" }).click();
    await expect(card.getByText("A new node that joins builds images.")).toBeVisible();

    await card.getByRole("button", { name: "Change", exact: true }).click();
    await expect(card.getByText("The panel could not be reached.")).toBeVisible();
    expect(sent["nodes.revokeJoinToken"]).toEqual([{ tokenId: "token00000000001" }]);
    await expect(card.getByText(/Single use · expires in/)).toBeVisible();
    await expect(card.getByText("A new node that joins builds images.")).toBeVisible();
    await expect(card.getByRole("checkbox", { name: "Build images on this node", exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/revoke-failed.png` });

    // Change again once the panel answers: now the command goes and the box comes back.
    await page.unroute(/\/api\/v1\/nodes\.revokeJoinToken/);
    await page.route(/\/api\/v1\/nodes\.revokeJoinToken/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await card.getByRole("button", { name: "Change", exact: true }).click();
    await expect(card.getByRole("checkbox", { name: "Build images on this node", exact: true })).toBeVisible();
    await expect(card.getByText("The panel could not be reached.")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Change on a command someone already ran says so and points to Can build", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installDemo(page);
    // What the panel answers for a used token (nodes/ops.ts revokeJoinToken).
    const used = { code: "NOT_FOUND", message: "No unused join token with this id." };
    await page.route(/\/api\/v1\/nodes\.revokeJoinToken/, (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: used }) }),
    );
    await page.goto("/nodes");
    const card = page.getByRole("region", { name: "Add a node" });
    await card.getByRole("button", { name: "Create join command" }).click();
    await card.getByRole("button", { name: "Change", exact: true }).click();

    const note = card.getByText(
      "That command was already used, so it can't be changed. Set Can build for the node that ran it in the list above.",
    );
    await expect(note).toBeVisible();
    await expect(card.getByText(used.message)).toHaveCount(0);
    // The used command is no good to anyone: the box is back for a new one.
    await expect(card.getByText(/Single use · expires in/)).toHaveCount(0);
    const box = card.getByRole("checkbox", { name: "Build images on this node", exact: true });
    await expect(box).toBeVisible();
    await page.screenshot({ path: `${shots}/revoke-used.png` });

    // A new command clears the note.
    await box.click();
    await card.getByRole("button", { name: "Create join command" }).click();
    await expect(card.getByText("A new node that joins does not build images.")).toBeVisible();
    await expect(note).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Add node in the page header creates the command with the box's value", async ({ page }) => {
    await installDemo(page);
    const sent = recordOps(page);
    await page.goto("/nodes");
    await page.getByRole("button", { name: "Add node", exact: true }).click();
    const card = page.getByRole("region", { name: "Add a node" });
    await expect(card.getByText("A new node that joins builds images.")).toBeVisible();
    expect(sent["nodes.createJoinToken"]).toEqual([{ canBuild: true }]);
  });
});
