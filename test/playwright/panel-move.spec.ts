// Settings > General > Move the panel to another server (0.2.8) with the
// demo data (demo/panel-move.ts): the card's states (blocked, ready with the
// node picker and its disabled nodes, nodes that cannot follow and the tick,
// running with its steps and the banner on every page, failed with Try
// again, done on the moved panel with Delete the old copy, and the old copy
// that says where the panel went). The ops are answered in the browser, so
// the requests the page sends are checked here; the panel's own tests
// (apps/panel/test/panel-move.test.ts) cover the server.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { moveCheck, moveNodes, moveStatus, movingStatus } from "./demo/panel-move";
import { DemoRefusal } from "./demo/refusal";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;
const shots = `${process.env.SHOTS_DIR ?? "shots"}/panel-move`;
mkdirSync(shots, { recursive: true });

/** Every op call the page sends, by op id: a mutation's body, a query's search parameters. */
function recordOps(page: Page) {
  const sent: Record<string, Input[]> = {};
  page.on("request", (request) => {
    const match = /\/api\/v1\/([a-zA-Z]+\.[a-zA-Z]+)/.exec(request.url());
    if (!match) return;
    const id = match[1] as string;
    if (request.method() === "GET") (sent[id] ??= []).push(Object.fromEntries(new URL(request.url()).searchParams));
    else if (request.method() === "POST") (sent[id] ??= []).push((request.postDataJSON() as Input | null) ?? {});
  });
  return sent;
}

const card = (page: Page) => page.locator("section", { has: page.getByRole("heading", { name: "Move the panel to another server" }) });
const startButton = (page: Page) => card(page).getByRole("button", { name: "Move the panel", exact: true });
const banner = (page: Page) => page.getByTestId("panel-move-banner");

async function pickTarget(page: Page, name: string) {
  await card(page).getByRole("combobox", { name: "Move to" }).click();
  await page.getByRole("option", { name }).click();
}

test.describe("panel move", () => {
  test.use({ storageState: stateFile });

  test("blocked: the panel's reasons in a list, Start stays off", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "panelMove.check": (input) =>
          moveCheck(input, {
            blocks: [
              {
                code: "workRunning",
                message: "1 deployment is queued or running. Try again once it finished.",
                soft: false,
              },
              {
                code: "tailscaleServe",
                message: "Turn off Serve on my tailnet first (Settings > Tailscale). Turn it on again on the new server once the move finished.",
                soft: false,
              },
            ],
          }),
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/general");
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByText("Everything moves: the database, the master key")).toBeVisible();
    await expect(card(page).getByText("Can't move the panel yet")).toBeVisible();
    await expect(card(page).getByText("1 deployment is queued or running. Try again once it finished.")).toBeVisible();
    await expect(card(page).getByText("Turn off Serve on my tailnet first")).toBeVisible();
    await expect(startButton(page)).toBeDisabled();
    await expect(banner(page)).toHaveCount(0);
    await card(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/blocked.png`, fullPage: true });
    expect(sent["panelMove.start"]).toBeUndefined();
  });

  test("ready: pick a node, the address is prefilled, confirm, and the move starts", async ({ page }) => {
    let status = moveStatus();
    await installDemo(page, {
      overrides: {
        "panelMove.status": () => status,
        "panelMove.start": (input) => {
          status = movingStatus({ step: "pausing", bytesDone: 0, bytesTotal: 0, targetAddress: input.address });
          return status;
        },
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/general");
    await expect(startButton(page)).toBeDisabled();

    await card(page).getByRole("combobox", { name: "Move to" }).click();
    // Nodes that cannot take the panel are listed with why, and cannot be picked.
    await expect(page.getByRole("option", { name: "de-fsn-1 (runs the panel now)" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("option", { name: "il-tlv-1 (agent too old)" })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("option", { name: "us-ash-1" }).click();

    const address = card(page).getByRole("textbox", { name: "Address" });
    await expect(address).toHaveValue("198.51.100.7");
    await expect(card(page).getByText("Nodes connect to https://198.51.100.7:3443.")).toBeVisible();
    await expect(card(page).getByText("3 nodes follow on their own: de-fsn-1, il-tlv-1 and us-ash-1.")).toBeVisible();
    await expect(card(page).getByText("Point the DNS record of panel.acme.dev at 198.51.100.7")).toBeVisible();
    await expect(startButton(page)).toBeEnabled();
    await card(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/ready.png`, fullPage: true });

    // A typo in the address is caught before the panel sees it.
    await address.fill("http://198.51.100.7");
    await expect(card(page).getByText("Enter only a host name or IP address, without http://, a port or a path.")).toBeVisible();
    await expect(startButton(page)).toBeDisabled();
    await address.fill("panel-2.acme.dev");
    // The warnings name the typed address, once it parses (the typo never went to the check).
    await expect(card(page).getByText("Point the DNS record of panel.acme.dev at panel-2.acme.dev")).toBeVisible();
    expect(sent["panelMove.check"]?.filter((input) => input.address)).toEqual([{ targetNodeId: ids.us, address: "panel-2.acme.dev" }]);
    await expect(address).toHaveValue("panel-2.acme.dev");

    await startButton(page).click();
    const dialog = page.getByRole("alertdialog", { name: "Move the panel to us-ash-1?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("then every node switches to panel-2.acme.dev")).toBeVisible();
    await page.screenshot({ path: `${shots}/confirm.png` });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(sent["panelMove.start"]).toBeUndefined();

    await startButton(page).click();
    await dialog.getByRole("button", { name: "Move the panel" }).click();
    await expect(dialog).toBeHidden();
    expect(sent["panelMove.start"]).toEqual([{ targetNodeId: ids.us, address: "panel-2.acme.dev" }]);
    await expect(card(page).getByText("Moving the panel to us-ash-1")).toBeVisible();
    await expect(banner(page)).toContainText("The panel is moving to us-ash-1: read-only for a few minutes.");
  });

  test("nodes that cannot follow: listed with why, and Start waits for the tick", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "panelMove.check": (input) =>
          moveCheck(input, {
            nodesToMove: input.targetNodeId ? [moveNodes.de, moveNodes.us] : [],
            nodesLeftBehind: input.targetNodeId ? [{ ...moveNodes.il, reason: "offline" }] : [],
            blocks: input.targetNodeId
              ? [
                  {
                    code: "nodesLeftBehind",
                    message: "il-tlv-1 is offline, so it cannot follow.",
                    nodeIds: [ids.il],
                    soft: true,
                  },
                ]
              : [],
          }),
        "panelMove.start": () => movingStatus(),
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/general");
    await pickTarget(page, "us-ash-1");
    await expect(card(page).getByText("These nodes cannot follow")).toBeVisible();
    await expect(card(page).getByText("il-tlv-1: offline")).toBeVisible();
    await expect(startButton(page)).toBeDisabled();
    const tick = card(page).getByRole("checkbox", { name: "I will join these again with seylo join --force afterwards" });
    await tick.click();
    await expect(startButton(page)).toBeEnabled();
    await card(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/left-behind.png`, fullPage: true });
    await startButton(page).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Move the panel" }).click();
    await expect.poll(() => sent["panelMove.start"]).toEqual([{ targetNodeId: ids.us, address: "198.51.100.7", leftBehind: true }]);
  });

  test("running: the steps with bytes, the banner on every page, and Cancel", async ({ page }) => {
    let status = movingStatus();
    await installDemo(page, {
      overrides: {
        "panelMove.status": () => status,
        "panelMove.cancel": () => {
          status = moveStatus({
            state: "failed",
            moveId: "move000000000001",
            targetNodeId: ids.us,
            targetNodeName: "us-ash-1",
            targetAddress: "198.51.100.7",
            step: "shipping",
            error: { step: "shipping", message: "Cancelled by you@example.com." },
          });
          return status;
        },
      },
    });
    const sent = recordOps(page);
    await page.goto("/");
    await expect(banner(page)).toContainText("The panel is moving to us-ash-1: read-only for a few minutes.");
    await page.goto("/settings/general");
    const progress = card(page).getByTestId("panel-move-progress");
    await expect(progress.getByText("Moving the panel to us-ash-1")).toBeVisible();
    await expect(progress.getByText("Pausing changes")).toBeVisible();
    await expect(progress.locator('[aria-current="step"]')).toContainText("Sending the copy to us-ash-1");
    await expect(progress.getByText("18 MB of 46 MB")).toBeVisible();
    await card(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/running.png`, fullPage: true });

    await card(page).getByRole("button", { name: "Cancel the move" }).click();
    await expect.poll(() => sent["panelMove.cancel"]).toEqual([{}]);
    await expect(card(page).getByText("The move to us-ash-1 stopped")).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });

  test("failed: where it stopped and why, then Try again shows the form", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "panelMove.status": () =>
          moveStatus({
            state: "failed",
            moveId: "move000000000001",
            targetNodeId: ids.us,
            targetNodeName: "us-ash-1",
            targetAddress: "198.51.100.7",
            step: "staging",
            error: {
              step: "staging",
              message:
                "il-tlv-1 could not reach the moved panel at https://198.51.100.7:3443: dial tcp 198.51.100.7:3443: i/o timeout. Open the agents' port 3443 on us-ash-1 to that node (a firewall or cloud security group), or move to another address.",
            },
          }),
      },
    });
    await page.goto("/settings/general");
    await expect(card(page).getByText("The move to us-ash-1 stopped")).toBeVisible();
    await expect(card(page).getByText("il-tlv-1 could not reach the moved panel at https://198.51.100.7:3443")).toBeVisible();
    await expect(card(page).getByText("At: Telling every node the new address.")).toBeVisible();
    await expect(card(page).getByText("Nothing changed: the panel runs here as before.")).toBeVisible();
    await card(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/failed.png`, fullPage: true });
    await card(page).getByRole("button", { name: "Try again" }).click();
    await expect(card(page).getByRole("combobox", { name: "Move to" })).toBeVisible();
    await expect(card(page).getByText("The move to us-ash-1 stopped")).toHaveCount(0);
  });

  test("a second failure shows too: Try again, the next move fails, its reason is on the card", async ({ page }) => {
    const failed = (moveId: string, message: string) =>
      moveStatus({
        state: "failed",
        moveId,
        targetNodeId: ids.us,
        targetNodeName: "us-ash-1",
        targetAddress: "198.51.100.7",
        step: "starting",
        error: { step: "starting", message },
      });
    let status = failed("move000000000001", "The first try stopped.");
    await installDemo(page, {
      overrides: {
        "panelMove.status": () => status,
        "panelMove.start": () => {
          status = movingStatus({ moveId: "move000000000002", step: "starting", bytesDone: 0, bytesTotal: 0 });
          return status;
        },
      },
    });
    await page.goto("/settings/general");
    await expect(card(page).getByText("The first try stopped.")).toBeVisible();
    await card(page).getByRole("button", { name: "Try again" }).click();
    await pickTarget(page, "us-ash-1");
    await startButton(page).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Move the panel" }).click();
    await expect(card(page).getByTestId("panel-move-progress")).toBeVisible();
    status = failed("move000000000002", "The second try stopped too.");
    await expect(card(page).getByText("The move to us-ash-1 stopped")).toBeVisible();
    await expect(card(page).getByText("The second try stopped too.")).toBeVisible();
    await expect(card(page).getByText("At: Starting the panel on us-ash-1.")).toBeVisible();
  });

  test("the check refreshes while the form shows: a block that cleared, and on focus", async ({ page }) => {
    let working = true;
    await installDemo(page, {
      overrides: {
        "panelMove.check": (input) =>
          moveCheck(input, {
            blocks: working ? [{ code: "workRunning", message: "A backup of db is running. Try again once it finished.", soft: false }] : [],
          }),
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/general");
    await pickTarget(page, "us-ash-1");
    await expect(card(page).getByText("A backup of db is running.")).toBeVisible();
    await expect(startButton(page)).toBeDisabled();
    // The backup finished: the next refresh (every 10 seconds) lifts the block.
    working = false;
    await expect(card(page).getByText("A backup of db is running.")).toHaveCount(0, { timeout: 15_000 });
    await expect(startButton(page)).toBeEnabled();
    // Back on the tab: it asks again at once.
    working = true;
    const before = sent["panelMove.check"]?.length ?? 0;
    // What the tab coming back to the front fires (the query cache listens on window).
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => sent["panelMove.check"]?.length ?? 0, { timeout: 3000 }).toBeGreaterThan(before);
    await expect(card(page).getByText("A backup of db is running.")).toBeVisible({ timeout: 3000 });
  });

  test("a start refused for a node that went offline meanwhile: the check refreshes and the tick shows", async ({ page }) => {
    let offline = false;
    await installDemo(page, {
      overrides: {
        "panelMove.check": (input) =>
          moveCheck(
            input,
            offline && input.targetNodeId
              ? {
                  nodesToMove: [moveNodes.de, moveNodes.us],
                  nodesLeftBehind: [{ ...moveNodes.il, reason: "offline" }],
                  blocks: [{ code: "nodesLeftBehind", message: "il-tlv-1 is offline, so it cannot follow.", nodeIds: [ids.il], soft: true }],
                }
              : {},
          ),
        "panelMove.start": (input) => {
          if (!input.leftBehind) {
            offline = true;
            throw new DemoRefusal(409, "CONFLICT", "il-tlv-1 is offline, so it cannot follow. Bring it back or tick that you will join it again.", {
              reason: "nodesLeftBehind",
              nodeIds: ids.il,
            });
          }
          return movingStatus();
        },
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/general");
    await pickTarget(page, "us-ash-1");
    await expect(startButton(page)).toBeEnabled();
    await startButton(page).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Move the panel" }).click();
    await expect(dialog.getByText("Bring it back or tick that you will join it again.")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    // Sooner than the 10 second refresh: the refusal itself asked again.
    const tick = card(page).getByRole("checkbox", { name: "I will join these again with seylo join --force afterwards" });
    await expect(tick).toBeVisible({ timeout: 3000 });
    await expect(card(page).getByText("il-tlv-1: offline")).toBeVisible();
    await expect(startButton(page)).toBeDisabled();
    await tick.click();
    await startButton(page).click();
    await dialog.getByRole("button", { name: "Move the panel" }).click();
    await expect
      .poll(() => sent["panelMove.start"])
      .toEqual([
        { targetNodeId: ids.us, address: "198.51.100.7" },
        { targetNodeId: ids.us, address: "198.51.100.7", leftBehind: true },
      ]);
  });

  test("the old panel stops answering at the end of a move the page missed: it says where the panel went, then stops asking", async ({
    page,
  }) => {
    await page.clock.install();
    await installDemo(page, {
      overrides: {
        "panelMove.status": () => movingStatus({ step: "switching", bytesDone: 0, bytesTotal: 0, canCancel: false }),
      },
    });
    let statusReads = 0;
    let gone = false;
    // Routes added later win: once gone, the old panel answers nothing at all.
    await page.route(/\/api\/v1\/panelMove\.status/, (route) => {
      statusReads++;
      return gone ? route.abort("connectionrefused") : route.fallback();
    });
    await page.goto("/settings/general");
    await expect(card(page).getByText("Moving the panel to us-ash-1")).toBeVisible();
    gone = true;
    await expect(card(page).getByText("The old server stopped answering at the last step of the move")).toBeVisible();
    await expect(card(page).getByRole("link", { name: "Open http://198.51.100.7:3000" })).toHaveAttribute("href", "http://198.51.100.7:3000");
    await expect(card(page).getByText("Could not load this")).toHaveCount(0);
    await expect(banner(page)).toContainText("The panel moved to us-ash-1.");
    await expect(banner(page).getByRole("link", { name: "Open it" })).toHaveAttribute("href", "http://198.51.100.7:3000");
    await card(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/lost.png`, fullPage: true });
    // Minutes later the page has stopped asking the dead address. The last
    // round (a read and its retries) ends in real time; then 30 seconds
    // more of the page's time bring no read.
    await page.clock.fastForward("03:00");
    await page.waitForTimeout(6000);
    const settled = statusReads;
    await page.clock.runFor(30_000);
    await page.waitForTimeout(4000);
    expect(statusReads).toBe(settled);
    await expect(card(page).getByRole("link", { name: "Open http://198.51.100.7:3000" })).toBeVisible();
  });

  test("the switch waits for the target: how long, the banner stays, and Cancel anyway after 10 minutes", async ({ page }) => {
    let status = movingStatus({
      step: "switching",
      bytesDone: 0,
      bytesTotal: 0,
      canCancel: false,
      waitingSince: new Date(Date.now() - 11 * 60_000).toISOString(),
      canForceCancel: true,
    });
    await installDemo(page, {
      overrides: {
        "panelMove.status": () => status,
        "panelMove.cancel": (input) => {
          if (input.force !== true) throw new DemoRefusal(409, "CONFLICT", "The switch started.", { reason: "switching" });
          status = moveStatus({
            state: "failed",
            moveId: "move000000000001",
            targetNodeId: ids.us,
            targetNodeName: "us-ash-1",
            targetAddress: "198.51.100.7",
            step: "switching",
            error: { step: "switching", message: "Cancelled by you@example.com: us-ash-1 never confirmed the switch." },
          });
          return status;
        },
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/general");
    const progress = card(page).getByTestId("panel-move-progress");
    await expect(progress.getByText("Waiting for us-ash-1 to confirm the switch")).toBeVisible();
    await expect(progress.getByText(/us-ash-1 has not answered for 1[01]m \d+s\./)).toBeVisible();
    await expect(progress.getByRole("button", { name: "Cancel the move" })).toHaveCount(0);
    await expect(banner(page)).toContainText("The panel is moving to us-ash-1 and waits for it to confirm the switch: read-only until then.");
    await card(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/waiting.png`, fullPage: true });

    await progress.getByRole("button", { name: "Cancel anyway" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Cancel the move anyway?" });
    await expect(dialog.getByText("Only for a target that is gone for good")).toBeVisible();
    await page.screenshot({ path: `${shots}/force-cancel.png` });
    await dialog.getByRole("button", { name: "Keep waiting" }).click();
    await expect(dialog).toBeHidden();
    expect(sent["panelMove.cancel"]).toBeUndefined();

    await progress.getByRole("button", { name: "Cancel anyway" }).click();
    await dialog.getByRole("button", { name: "Cancel anyway" }).click();
    await expect(dialog).toBeHidden();
    expect(sent["panelMove.cancel"]).toEqual([{ force: true }]);
    await expect(card(page).getByText("The move to us-ash-1 stopped")).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });

  test("done on the moved panel: the DNS record, who to join again, Delete the old copy", async ({ page }) => {
    let status = movingStatus({
      state: "done",
      side: "new",
      step: null,
      bytesDone: 0,
      bytesTotal: 0,
      canCancel: false,
      domain: "panel.acme.dev",
      leftBehind: [moveNodes.il],
      doneAt: new Date(Date.now() - 120_000).toISOString(),
    });
    await installDemo(page, {
      overrides: {
        "panelMove.status": () => status,
        "panelMove.removeOldCopy": () => {
          status = { ...status, oldCopyRemoved: true };
          return { freedBytes: 812 * 1024 * 1024, status };
        },
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/general");
    const result = card(page).getByTestId("panel-move-result");
    await expect(result.getByText("The panel moved to us-ash-1")).toBeVisible();
    await expect(result.getByText("Point the DNS record of panel.acme.dev at 198.51.100.7.")).toBeVisible();
    await expect(result.getByText("with --force on each: il-tlv-1.")).toBeVisible();
    await expect(result.getByText("The old copy of the panel is still on de-fsn-1, stopped.")).toBeVisible();
    // No banner on the moved panel: it takes changes again.
    await expect(banner(page)).toHaveCount(0);
    await card(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/done.png`, fullPage: true });

    await result.getByRole("button", { name: "Delete the old copy" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete the old copy on de-fsn-1?" });
    await expect(dialog.getByText("It cannot be undone.")).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Delete the old copy" });
    // The node's name has to be typed first.
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("textbox").fill("de-fsn-1");
    await confirm.click();
    await expect(dialog).toBeHidden();
    expect(sent["panelMove.removeOldCopy"]).toEqual([{}]);
    await expect(page.getByText("Deleted the old copy on de-fsn-1 (812 MB freed)")).toBeVisible();
    await expect(result.getByText("The old copy on de-fsn-1 is deleted.")).toBeVisible();
  });

  test("the old copy: where the panel is now, on the card and every page", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "panelMove.status": () => movingStatus({ state: "done", side: "old", step: "switching", canCancel: false, domain: null }),
      },
    });
    await page.goto("/settings/general");
    await expect(card(page).getByText("This is the old copy.")).toBeVisible();
    await expect(card(page).getByRole("link", { name: "Open http://198.51.100.7:3000" })).toHaveAttribute("href", "http://198.51.100.7:3000");
    await expect(banner(page)).toContainText("The panel moved to us-ash-1.");
    await expect(banner(page).getByRole("link", { name: "Open it" })).toHaveAttribute("href", "http://198.51.100.7:3000");
    await page.screenshot({ path: `${shots}/old-copy.png`, fullPage: true });
  });

  test("the old copy with a domain: Open goes to the new IP address, the domain once its DNS points there", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "panelMove.status": () =>
          movingStatus({ state: "done", side: "old", step: "switching", canCancel: false, domain: "panel.acme.dev" }),
      },
    });
    await page.goto("/settings/general");
    // Right after the move the domain's DNS record still points at this old server.
    await expect(card(page).getByRole("link", { name: "Open http://198.51.100.7:3000" })).toHaveAttribute("href", "http://198.51.100.7:3000");
    await expect(card(page).getByText("works too once its DNS record points at 198.51.100.7.")).toBeVisible();
    await expect(card(page).getByRole("link", { name: "panel.acme.dev" })).toHaveAttribute("href", "https://panel.acme.dev");
    await expect(banner(page).getByRole("link", { name: "Open it" })).toHaveAttribute("href", "http://198.51.100.7:3000");
    await expect(banner(page)).toContainText("panel.acme.dev works once its DNS record points at the new server");
    await expect(banner(page).getByRole("link", { name: "panel.acme.dev" })).toHaveAttribute("href", "https://panel.acme.dev");
    await page.screenshot({ path: `${shots}/old-copy-domain.png`, fullPage: true });
  });
});
