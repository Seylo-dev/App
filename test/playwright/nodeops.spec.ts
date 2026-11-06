// The node sheet's Cleanup and Shell views with the demo data (demo/*.ts):
// saving a cleanup schedule, the run history, allowing host shells and
// opening one through the terminal, and what an admin who may not turn
// them on sees. The ops are answered in the browser, so the requests the
// screens send are checked here; the panel's own tests cover the server.

import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { ids, cleanupSchedule } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { stateFile } from "./helpers";

type Input = Record<string, any>;
const node = ids.de;
const shots = `${process.env.SHOTS_DIR ?? "shots"}/nodeops`;
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

test.describe("node operations", () => {
  test.use({ storageState: stateFile });

  test("cleanup: the schedule saves what was picked and the runs show what they freed", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let saved = cleanupSchedule(node).schedule;
    await installDemo(page, {
      overrides: {
        "cleanup.getSchedule": () => ({ ...cleanupSchedule(node), schedule: saved }),
        "cleanup.setSchedule": (input) => {
          saved = input.schedule;
          return { nodeId: node, schedule: saved, nextRunAt: null };
        },
      },
    });
    const sent = recordOps(page);
    await page.goto(`/nodes?node=${node}&view=cleanup`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: "Scheduled cleanup" })).toBeVisible();
    await expect(sheet.locator('[data-slot="skeleton"]')).toHaveCount(0);

    // The runs: freed space, the trigger and the 30-day total.
    const runs = sheet.getByRole("list", { name: "Recent cleanups" });
    await expect(runs.getByRole("listitem").filter({ hasText: "Schedule" }).first()).toContainText("3.2 GB freed");
    await expect(runs.getByText("Disk 87%")).toBeVisible();
    await expect(runs.getByText("Manual, you@example.com")).toBeVisible();
    await expect(runs.getByText("Failed")).toBeVisible();
    await expect(sheet.getByText("10 GB freed in the last 30 days")).toBeVisible();
    await runs.getByText("What it removed").first().click();
    await expect(runs.getByText("image registry/acme/api:41 (1.4 GiB): older than the newest 3")).toBeVisible();

    // The node's time zone and the next run.
    await expect(sheet.getByText("Times are in the node's time zone (Europe/Berlin).", { exact: false })).toBeVisible();
    await expect(sheet.getByText(/Next run in \d+ hours/)).toBeVisible();

    const save = sheet.getByRole("button", { name: "Save schedule" });
    await expect(save).toBeDisabled();
    await sheet.getByLabel("Cron expression").fill("30 3 * * 1-5");
    await sheet.getByLabel("Percent").fill("90");
    await sheet.getByLabel("Build cache").click();
    // Volumes need their own switch, and say why.
    await sheet.getByLabel("Unused volumes").click();
    await expect(sheet.getByText("Once cleaned up it is gone for good.", { exact: false })).toBeVisible();
    await save.click();
    await expect(page.getByText("Cleanup schedule saved")).toBeVisible();
    await page.screenshot({ path: `${shots}/cleanup-saved.png` });
    expect(sent["cleanup.setSchedule"]).toEqual([
      {
        nodeId: node,
        schedule: {
          enabled: true,
          cron: "30 3 * * 1-5",
          diskPercent: 90,
          kinds: { images: true, buildCache: false, stoppedContainers: true, unusedVolumes: true },
        },
      },
    ]);

    // Disk only: no cron expression is sent.
    await sheet.getByLabel("On a schedule").click();
    await expect(sheet.getByLabel("Cron expression")).toBeDisabled();
    await sheet.getByRole("button", { name: "Save schedule" }).click();
    await expect.poll(() => sent["cleanup.setSchedule"]?.length).toBe(2);
    expect(sent["cleanup.setSchedule"]?.[1]?.schedule).toMatchObject({ cron: null, diskPercent: 90 });
    expect(errors).toEqual([]);
  });

  test("cleanup: a save elsewhere keeps unsaved edits and offers to load it", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let saved = cleanupSchedule(node).schedule;
    await installDemo(page, {
      overrides: { "cleanup.getSchedule": () => ({ ...cleanupSchedule(node), schedule: saved }) },
    });
    // The live socket: tell the sheet that cleanup.getSchedule changed, as
    // the panel does after any cleanup.setSchedule for the node.
    let live: { send(text: string): void } | null = null;
    await page.routeWebSocket(/\/api\/live/, (ws) => {
      ws.onMessage((raw) => {
        const message = JSON.parse(String(raw)) as { type: string; topic: string };
        if (message.type !== "subscribe") return;
        ws.send(JSON.stringify({ type: "subscribed", topic: message.topic }));
        if (message.topic === `node:${node}`) live = ws;
      });
    });
    const savedElsewhere = async (schedule: typeof saved) => {
      saved = schedule;
      await expect.poll(() => live !== null).toBe(true);
      live?.send(JSON.stringify({ type: "event", topic: `node:${node}`, event: { type: "invalidate", ops: ["cleanup.getSchedule"] } }));
    };
    await page.goto(`/nodes?node=${node}&view=cleanup`);
    const sheet = page.getByRole("dialog");
    const cron = sheet.getByLabel("Cron expression");
    await expect(cron).toHaveValue("0 4 * * *");

    // Nobody is editing: the new schedule replaces the fields without a note.
    await savedElsewhere({ ...saved, cron: "0 5 * * *" });
    await expect(cron).toHaveValue("0 5 * * *");
    const note = sheet.getByText("Someone else saved this schedule while you were editing it.", { exact: false });
    await expect(note).toHaveCount(0);

    // Editing: the edit stays and a note offers the saved version.
    await cron.fill("30 2 * * 1-5");
    await savedElsewhere({ ...saved, cron: "0 6 * * *", diskPercent: 85 });
    await expect(note).toBeVisible();
    await expect(cron).toHaveValue("30 2 * * 1-5");
    await expect(sheet.getByRole("button", { name: "Save schedule" })).toBeEnabled();
    await page.screenshot({ path: `${shots}/cleanup-changed-elsewhere.png` });
    await sheet.getByRole("button", { name: "Load the saved schedule" }).click();
    await expect(cron).toHaveValue("0 6 * * *");
    await expect(sheet.getByLabel("Percent")).toHaveValue("85");
    await expect(note).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Save schedule" })).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test("shell: the owner allows host shells, opens one and types into it", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let enabled = false;
    const status = () => ({
      nodeId: node,
      enabled,
      available: true,
      canOpen: true,
      canEnable: true,
      maxSessions: 2,
      idleTimeoutSeconds: 900,
      sessions: [],
    });
    await installDemo(page, {
      overrides: {
        "hostShell.status": status,
        "hostShell.setEnabled": (input) => {
          enabled = input.enabled;
          return { nodeId: node, enabled };
        },
        "hostShell.open": () => ({
          url: "/api/streams/host-shell?t=demo",
          ticket: "demo",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          nodeId: node,
          nodeName: "de-fsn-1",
          idleTimeoutSeconds: 900,
        }),
      },
    });
    const typed: string[] = [];
    await page.routeWebSocket(/\/api\/streams\/host-shell/, (ws) => {
      ws.send(JSON.stringify({ type: "ready", containerId: "", generation: 0, user: "root", workdir: "/root" }));
      ws.send(Buffer.from("root@de-fsn-1:~# ", "utf8"));
      ws.onMessage((message) => {
        if (typeof message === "string") return;
        const text = Buffer.from(message).toString("utf8");
        typed.push(text);
        ws.send(Buffer.from(text === "\r" ? "\r\nde-fsn-1\r\nroot@de-fsn-1:~# " : text, "utf8"));
      });
    });
    const sent = recordOps(page);
    await page.goto(`/nodes?node=${node}&view=shell`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: "Host shells are off for this node" })).toBeVisible();

    await sheet.getByRole("button", { name: "Allow host shells" }).click();
    const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: /Allow root shells/ }));
    await expect(confirm.getByText("Allow root shells on de-fsn-1?")).toBeVisible();
    await confirm.getByRole("button", { name: "Allow host shells" }).click();
    await expect(page.getByText("Host shells are allowed on de-fsn-1")).toBeVisible();
    expect(sent["hostShell.setEnabled"]).toEqual([{ nodeId: node, enabled: true }]);

    await expect(sheet.getByText("At most 2 open at a time.", { exact: false })).toBeVisible();
    await sheet.getByRole("button", { name: "Open root shell" }).click();
    const terminal = sheet.getByRole("region", { name: "Root shell on de-fsn-1" }).last();
    await expect(terminal.getByText("Connected to de-fsn-1 as root in /root", { exact: false })).toBeVisible();
    await expect(terminal.getByText("root@de-fsn-1:~#").first()).toBeVisible();
    expect(sent["hostShell.open"]?.[0]).toMatchObject({ nodeId: node });

    await terminal.locator(".xterm").click();
    await page.keyboard.type("hostname");
    await page.keyboard.press("Enter");
    await expect(terminal.getByText("de-fsn-1", { exact: true }).first()).toBeVisible();
    expect(typed.join("")).toBe("hostname\r");
    await page.screenshot({ path: `${shots}/host-shell.png` });

    await terminal.getByRole("button", { name: "Close shell" }).click();
    await expect(sheet.getByRole("button", { name: "Open root shell" })).toBeVisible();

    await sheet.getByRole("button", { name: "Turn off" }).click();
    await expect(page.getByText("Host shells are off for de-fsn-1", { exact: false })).toBeVisible();
    expect(sent["hostShell.setEnabled"]?.[1]).toEqual({ nodeId: node, enabled: false });
    expect(errors).toEqual([]);
  });

  test("shell: an admin cannot turn host shells on", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "hostShell.status": () => ({
          nodeId: node,
          enabled: false,
          available: true,
          canOpen: true,
          canEnable: false,
          maxSessions: 2,
          idleTimeoutSeconds: 900,
          sessions: [],
        }),
      },
    });
    await page.goto(`/nodes?node=${node}&view=shell`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Only the owner can turn them on.")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Allow host shells" })).toHaveCount(0);
  });
});
