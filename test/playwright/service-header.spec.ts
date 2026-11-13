// The service header's run buttons on the demo data: Restart, Stop and
// Start carry an icon next to their label, Deploy stays text only, and the
// buttons keep their plain names (the icons are hidden from screen readers).
// While an app moves to another node (0.2.16) the header says "Moving to
// <node>...", Cancel move asks first, and Deploy waits for the move.

import type { Locator } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { handlers as serviceHandlers, servicesById, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const api = `/p/${ids.acme}/s/${svc.api}`;
const icons = (button: Locator) => button.locator("svg");

test.describe("service header", () => {
  test.use({ storageState: stateFile });

  test("Restart and Stop have icons, Deploy has none", async ({ page }) => {
    await installDemo(page);
    await page.goto(api);
    const header = page.locator("main header").first();
    const restart = header.getByRole("button", { name: "Restart", exact: true });
    const stop = header.getByRole("button", { name: "Stop", exact: true });
    const deploy = header.getByRole("button", { name: "Deploy", exact: true });
    await expect(restart).toBeVisible();
    await expect(icons(restart)).toHaveCount(1);
    await expect(icons(stop)).toHaveCount(1);
    await expect(icons(restart)).toHaveAttribute("aria-hidden", "true");
    await expect(icons(stop)).toHaveAttribute("aria-hidden", "true");
    await expect(deploy).toBeVisible();
    await expect(icons(deploy)).toHaveCount(0);
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/service-header-icons.png`, clip: (await header.boundingBox()) ?? undefined });
  });

  test("a stopped service's Start has an icon", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "services.get": (input) => ({ ...(servicesById as Record<string, object>)[String(input.serviceId)], status: "stopped", stopped: true }),
      },
    });
    await page.goto(api);
    const header = page.locator("main header").first();
    const start = header.getByRole("button", { name: "Start", exact: true });
    await expect(start).toBeVisible();
    await expect(icons(start)).toHaveCount(1);
    await expect(icons(start)).toHaveAttribute("aria-hidden", "true");
    await expect(header.getByRole("button", { name: "Restart", exact: true })).toHaveCount(0);
  });

  test("an app moving to another node: Moving to <node>..., Cancel move after a confirm, Deploy waits (0.2.16)", async ({ page }) => {
    const de = { id: ids.de, name: "de-fsn-1" };
    const us = { id: ids.us, name: "us-ash-1" };
    const history = serviceHandlers["deployments.list"]?.({ serviceId: svc.worker }) as { deployments: Record<string, unknown>[] };
    let move: Record<string, unknown> | null = {
      ...history.deployments[0],
      id: "d000000000000095",
      serviceId: svc.api,
      status: "deploying",
      trigger: "move",
      commit: null,
      source: null,
      builder: null,
      builtOn: null,
      // Without volumes it rolls out on both nodes, and the old copy keeps serving until the new one does.
      move: { from: de, to: us, copying: false, canCancel: true },
    };
    const cancels: Record<string, unknown>[] = [];
    await installDemo(page, {
      overrides: {
        "deployments.list": (input) =>
          input.serviceId === svc.api && String(input.active) === "true"
            ? { deployments: move ? [move] : [], nextCursor: null, keptImages: 0 }
            : serviceHandlers["deployments.list"]?.(input),
        "deployments.cancel": (input) => {
          cancels.push(input);
          const done = { ...move, status: "cancelled", move: { from: de, to: us, copying: false, canCancel: false } };
          move = null;
          return done;
        },
      },
    });
    await page.goto(api);
    const header = page.locator("main header").first();
    await expect(header.getByRole("status")).toContainText("Moving to us-ash-1...");
    await expect(header.getByRole("status")).toHaveAttribute("title", "It keeps running on de-fsn-1 until it runs on us-ash-1.");
    const deploy = header.getByRole("button", { name: "Deploy", exact: true });
    await expect(deploy).toBeDisabled();
    await expect(deploy).toHaveAttribute("title", "It is moving to another node. Deploy once the move ends.");
    await expect(header.getByRole("button", { name: "Cancel deploy", exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/service-header-moving.png`, clip: (await header.boundingBox()) ?? undefined });

    await header.getByRole("button", { name: "Cancel move", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "Cancel moving api to us-ash-1?" })).toBeVisible();
    await expect(dialog).toContainText("api keeps running on de-fsn-1, and its new copy on us-ash-1 is removed.");
    await dialog.getByRole("button", { name: "Cancel move", exact: true }).click();
    await expect(page.getByText("Move cancelled. api runs on de-fsn-1.")).toBeVisible();
    expect(cancels).toEqual([{ serviceId: svc.api, deploymentId: "d000000000000095" }]);
    await expect(header.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
    await expect(deploy).toBeEnabled();
  });
});
