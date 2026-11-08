// Settings > Updates with the demo data (demo/*.ts): the release channel
// (owner only, with a confirmation before following pre-releases), the
// version on offer, a pre-release kept on the stable channel, and what the
// history says about a node that was offline during a run. The ops are
// answered in the browser, so the requests the page sends are checked here;
// the panel's own tests cover the server.

import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { updateStatus } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { stateFile } from "./helpers";

type Input = Record<string, any>;
const shots = `${process.env.SHOTS_DIR ?? "shots"}/updates`;
mkdirSync(shots, { recursive: true });

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

const step = (over: Record<string, unknown>) => ({
  id: "s0",
  position: 0,
  target: "agent",
  nodeId: "node00000000000a",
  nodeName: "de-fsn-1",
  fromVersion: "0.9.3",
  toVersion: "0.9.4",
  status: "succeeded",
  error: null,
  startedAt: null,
  finishedAt: null,
  retry: null,
  retryRunId: null,
  retryAt: null,
  ...over,
});

const at = new Date(Date.now() - 3 * 3600_000).toISOString();
const history = {
  runs: [
    {
      id: "run000000000002",
      targetVersion: "0.9.4",
      trigger: "reconnect",
      status: "succeeded",
      startedBy: null,
      error: null,
      createdAt: at,
      finishedAt: at,
      doneSteps: 1,
      totalSteps: 1,
      steps: [step({ id: "r1", nodeName: "us-ash-1" })],
    },
    {
      id: "run000000000001",
      targetVersion: "0.9.4",
      trigger: "manual",
      status: "succeeded",
      startedBy: "user000000000001",
      error: null,
      createdAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
      finishedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
      doneSteps: 2,
      totalSteps: 2,
      steps: [
        step({ id: "m1" }),
        step({
          id: "m2",
          nodeName: "us-ash-1",
          status: "skipped",
          error: "The node is offline; it gets the update when it reconnects.",
          retry: "retried",
          retryRunId: "run000000000002",
          retryAt: at,
        }),
        step({ id: "m3", nodeName: "sg-sin-1", status: "skipped", error: "The node is offline; it gets the update when it reconnects.", retry: "waiting" }),
      ],
    },
  ],
  hasMore: false,
};

test.describe("updates", () => {
  test.use({ storageState: stateFile });

  test("the owner follows pre-releases after confirming and sees the release on offer", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let status: Record<string, any> = { ...updateStatus, activeRun: null };
    await installDemo(page, {
      overrides: {
        "updates.status": () => status,
        "updates.history": () => history,
        "updates.setChannel": (input) => {
          status = {
            ...status,
            channel: input.channel,
            panel: { ...status.panel, latestVersion: "0.9.5-rc.1", updateAvailable: true, offeredVersion: "0.9.5-rc.1", latestIsPrerelease: true },
          };
          return status;
        },
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/updates");
    const channel = page.getByRole("radiogroup", { name: "Release channel" });
    await expect(channel.getByRole("radio", { name: "Stable" })).toHaveAttribute("data-state", "on");
    await expect(page.getByText("Only final releases are offered.")).toBeVisible();
    await expect(page.getByText("Newest stable")).toBeVisible();

    // Following pre-releases asks first; cancelling sends nothing.
    await channel.getByRole("radio", { name: "Pre-release" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Follow pre-releases?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(sent["updates.setChannel"]).toBeUndefined();

    await channel.getByRole("radio", { name: "Pre-release" }).click();
    await dialog.getByRole("button", { name: "Follow pre-releases" }).click();
    await expect(page.getByText("Following pre-releases")).toBeVisible();
    expect(sent["updates.setChannel"]).toEqual([{ channel: "prerelease" }]);
    await expect(channel.getByRole("radio", { name: "Pre-release" })).toHaveAttribute("data-state", "on");
    await expect(page.getByText("0.9.5-rc.1 available")).toBeVisible();
    await expect(page.getByRole("button", { name: "Update to 0.9.5-rc.1" })).toBeVisible();
    await expect(page.locator('[data-slot="chip"]', { hasText: /^Pre-release$/ })).toBeVisible();
    await page.screenshot({ path: `${shots}/prerelease.png` });

    // Back to stable needs no confirmation.
    await channel.getByRole("radio", { name: "Stable" }).click();
    await expect.poll(() => sent["updates.setChannel"]).toEqual([{ channel: "prerelease" }, { channel: "stable" }]);
    expect(errors).toEqual([]);
  });

  test("history says what became of nodes that were offline during a run", async ({ page }) => {
    await installDemo(page, { overrides: { "updates.status": () => ({ ...updateStatus, activeRun: null }), "updates.history": () => history } });
    await page.goto("/settings/updates");
    const table = page.getByRole("table", { name: "History" });
    await expect(table.getByText("Node came back")).toBeVisible();
    const retried = table.getByLabel(/^us-ash-1: Skipped\./);
    await retried.hover();
    await expect(page.getByRole("tooltip", { name: /It came back and was updated in a run of its own/ })).toBeVisible();
    const waiting = table.getByLabel(/^sg-sin-1: Skipped\./);
    await waiting.focus();
    await expect(page.getByRole("tooltip", { name: /It gets 0\.9\.4 when it reconnects\./ })).toBeVisible();
    await page.screenshot({ path: `${shots}/history.png` });
  });

  test("an admin sees the channel but cannot change it; a pre-release panel on stable says it stays", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "updates.status": () => ({
          ...updateStatus,
          activeRun: null,
          canChangeChannel: false,
          panel: { ...updateStatus.panel, currentVersion: "0.9.5-rc.1", latestVersion: "0.9.4" },
        }),
        "updates.history": () => history,
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/updates");
    const channel = page.getByRole("radiogroup", { name: "Release channel" });
    await expect(channel.getByRole("radio", { name: "Pre-release" })).toBeDisabled();
    await expect(page.getByText("Only the owner can change it.", { exact: false })).toBeVisible();
    await expect(page.getByText("This panel runs the pre-release 0.9.5-rc.1 and stays on it until a newer stable release is out.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Update to/ })).toHaveCount(0);
    await channel.getByRole("radio", { name: "Pre-release" }).click({ force: true });
    expect(sent["updates.setChannel"]).toBeUndefined();
  });
});
