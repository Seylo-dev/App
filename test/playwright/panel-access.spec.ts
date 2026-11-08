// Settings > General > Panel domain with the demo data (demo/*.ts): the
// "Serve on IP address" and "Agents' port" switches in their states (open
// and blocked, open and allowed, closed, reopened by itself), the confirm
// dialog before turning IP access off, and "Keep IP access closed", which
// needs the tick that the recovery commands are saved. The ops are
// answered in the browser, so the requests the page sends are checked
// here; the panel's own tests (apps/panel/test/panel-access.test.ts,
// ip-access.test.ts) cover the server.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;
const shots = `${process.env.SHOTS_DIR ?? "shots"}/panel-access`;
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

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/** settings.panelAccess for the demo panel (de-fsn-1 at 203.0.113.10, panel.acme.dev active), opened over the domain. */
function access(over: Input = {}): Input {
  return {
    serveOnIp: true,
    agentPortOpen: true,
    onFailure: "reopen",
    panelPort: 3000,
    agentPort: 3443,
    actual: { ip: "open", agentPort: "open" },
    privatePaths: [{ kind: "domain", url: "https://panel.acme.dev", working: true, since: ago(3 * 24 * 60), usingNow: true }],
    blocked: [],
    agentPortBlocked: [],
    reclosesAt: null,
    lastChange: null,
    recovery: { sshTunnel: "ssh -L 3000:127.0.0.1:3000 root@203.0.113.10", cli: "sudo seylo panel ip-access on" },
    ...over,
  };
}

/** A panel whose updatePanelAccess applies at once, as the agent would after the restart. */
function statefulAccess(start: Input) {
  let state = start;
  return {
    "settings.panelAccess": () => state,
    "settings.updatePanelAccess": (input: Input) => {
      const { savedRecovery: _saved, ...choices } = input;
      state = { ...state, ...choices };
      state.actual = { ip: state.serveOnIp ? "open" : "closed", agentPort: state.serveOnIp || state.agentPortOpen ? "open" : "closed" };
      state.lastChange = { at: new Date().toISOString(), reason: "Serve on IP address turned off in Settings", by: "you@acme.dev" };
      return state;
    },
  };
}

const card = (page: Page) => page.locator("section", { has: page.getByRole("heading", { name: "Panel domain" }) });
const serveOnIp = (page: Page) => card(page).getByRole("switch", { name: "Serve on IP address" });
const agentPort = (page: Page) => card(page).getByRole("switch", { name: "Agents' port" });

test.describe("panel access", () => {
  test.use({ storageState: stateFile });

  test("from IP:port the switch is locked and says where to go instead", async ({ page }) => {
    // The demo's own answer: opened on http://203.0.113.10:3000, the domain works.
    await installDemo(page);
    const sent = recordOps(page);
    await page.goto("/settings/general");
    await expect(serveOnIp(page)).toBeChecked();
    await expect(serveOnIp(page)).toBeDisabled();
    await expect(card(page).getByText("Can't turn it off yet")).toBeVisible();
    await expect(card(page).getByText("You opened the panel on http://203.0.113.10:3000. Open https://panel.acme.dev")).toBeVisible();
    await expect(card(page).getByText("Off: http://203.0.113.10:3000 only answers on the server itself (127.0.0.1).")).toBeVisible();
    // The agents' port waits for IP access.
    await expect(agentPort(page)).toBeDisabled();
    await expect(card(page).getByText("Turn off Serve on IP address first.")).toBeVisible();
    // The recovery commands are on the card before anything closes.
    await expect(card(page).getByText("ssh -L 3000:127.0.0.1:3000 root@203.0.113.10")).toBeVisible();
    await expect(card(page).getByText("sudo seylo panel ip-access on")).toBeVisible();
    await page.screenshot({ path: `${shots}/blocked.png`, fullPage: true });
    expect(sent["settings.updatePanelAccess"]).toBeUndefined();
  });

  test("over the domain it can close: the dialog warns and shows the SSH command first", async ({ page }) => {
    await installDemo(page, { overrides: statefulAccess(access()) });
    const sent = recordOps(page);
    await page.goto("/settings/general");
    await expect(card(page).getByText("You are here")).toBeVisible();
    await expect(serveOnIp(page)).toBeEnabled();

    await serveOnIp(page).click();
    const dialog = page.getByRole("alertdialog", { name: "Turn off Serve on IP address?" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("The panel restarts for a few seconds. Afterwards http://203.0.113.10:3000 only answers on the server itself."),
    ).toBeVisible();
    await expect(dialog.getByText("API keys, the CLI and scripts that use http://203.0.113.10:3000 stop working.")).toBeVisible();
    await expect(dialog.getByText("ssh -L 3000:127.0.0.1:3000 root@203.0.113.10")).toBeVisible();
    await page.screenshot({ path: `${shots}/confirm.png` });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(sent["settings.updatePanelAccess"]).toBeUndefined();
    await expect(serveOnIp(page)).toBeChecked();

    await serveOnIp(page).click();
    await dialog.getByRole("button", { name: "Turn off" }).click();
    await expect(dialog).toBeHidden();
    expect(sent["settings.updatePanelAccess"]).toEqual([{ serveOnIp: false }]);
    await expect(page.getByText("Saved. The panel restarts for a few seconds.")).toBeVisible();
    await expect(serveOnIp(page)).not.toBeChecked();
    await expect(card(page).getByText("IP access is closed: http://203.0.113.10:3000 only answers on the server.")).toBeVisible();
    // Now the agents' port can follow.
    await expect(agentPort(page)).toBeEnabled();
    await agentPort(page).click();
    const agentDialog = page.getByRole("alertdialog", { name: "Turn off the agents' port?" });
    await expect(agentDialog.getByText("Afterwards nodes reach it only over https://panel.acme.dev.")).toBeVisible();
    await agentDialog.getByRole("button", { name: "Turn off" }).click();
    await expect.poll(() => sent["settings.updatePanelAccess"]).toEqual([{ serveOnIp: false }, { agentPortOpen: false }]);
    await expect(card(page).getByText("The agents' port is closed: nodes reach the panel over the domain.")).toBeVisible();
  });

  test("closed: turning it back on needs no dialog", async ({ page }) => {
    await installDemo(page, {
      overrides: statefulAccess(
        access({
          serveOnIp: false,
          actual: { ip: "closed", agentPort: "open" },
          lastChange: { at: ago(20), reason: "Serve on IP address turned off in Settings", by: "you@acme.dev" },
        }),
      ),
    });
    const sent = recordOps(page);
    await page.goto("/settings/general");
    await expect(serveOnIp(page)).not.toBeChecked();
    await expect(card(page).getByText("IP access is closed: http://203.0.113.10:3000 only answers on the server.")).toBeVisible();
    await expect(card(page).getByText("Last change 20 min ago: Serve on IP address turned off in Settings (you@acme.dev).")).toBeVisible();
    await expect(card(page).getByText("Removing or changing the domain reopens IP access at once")).toBeVisible();
    await page.screenshot({ path: `${shots}/closed.png`, fullPage: true });

    await serveOnIp(page).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect.poll(() => sent["settings.updatePanelAccess"]).toEqual([{ serveOnIp: true }]);
    await expect(serveOnIp(page)).toBeChecked();
  });

  test("reopened by itself: the card says why and when it closes again", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "settings.panelAccess": () =>
          access({
            serveOnIp: false,
            actual: { ip: "open", agentPort: "open" },
            privatePaths: [{ kind: "domain", url: "https://panel.acme.dev", working: true, since: ago(19), usingNow: true }],
            reclosesAt: inMinutes(41),
            lastChange: { at: ago(26), reason: "the panel domain panel.acme.dev stopped working", by: "system" },
          }),
      },
    });
    await page.goto("/settings/general");
    await expect(serveOnIp(page)).not.toBeChecked();
    await expect(card(page).getByText("IP access is open again: the panel domain panel.acme.dev stopped working.")).toBeVisible();
    await expect(card(page).getByText("It closes again in 41 minutes if a private path keeps working.")).toBeVisible();
    await page.screenshot({ path: `${shots}/reopened.png`, fullPage: true });
  });

  test("keep IP access closed needs the tick; reopen saves at once", async ({ page }) => {
    await installDemo(page, { overrides: statefulAccess(access()) });
    const sent = recordOps(page);
    await page.goto("/settings/general");
    const choice = card(page).getByRole("radiogroup", { name: "If the domain stops working" });
    await expect(choice.getByRole("radio", { name: /Reopen IP access/ })).toBeChecked();

    await choice.getByRole("radio", { name: /Keep IP access closed/ }).click();
    const keep = card(page).getByRole("button", { name: "Keep it closed" });
    await expect(keep).toBeDisabled();
    expect(sent["settings.updatePanelAccess"]).toBeUndefined();
    await card(page).getByLabel("I saved the recovery commands below").check();
    await expect(keep).toBeEnabled();
    await keep.click();
    await expect.poll(() => sent["settings.updatePanelAccess"]).toEqual([{ onFailure: "stayClosed", savedRecovery: true }]);
    await expect(choice.getByRole("radio", { name: /Keep IP access closed/ })).toBeChecked();
    await expect(card(page).getByText("only these and the domain itself get you back in")).toBeVisible();
    await expect(keep).toHaveCount(0);

    await choice.getByRole("radio", { name: /Reopen IP access/ }).click();
    await expect
      .poll(() => sent["settings.updatePanelAccess"])
      .toEqual([{ onFailure: "stayClosed", savedRecovery: true }, { onFailure: "reopen" }]);
  });

  test("IP access off, opened over the SSH tunnel: the agents' port says why it is locked", async ({ page }) => {
    const tunnel = {
      code: "notOnPrivatePath",
      message: "You opened the panel on http://127.0.0.1:3000. Open https://panel.acme.dev and sign in there, then turn this off from that page.",
    };
    await installDemo(page, {
      overrides: {
        "settings.panelAccess": () =>
          access({
            serveOnIp: false,
            actual: { ip: "closed", agentPort: "open" },
            privatePaths: [{ kind: "domain", url: "https://panel.acme.dev", working: true, since: ago(60), usingNow: false }],
            blocked: [tunnel],
            agentPortBlocked: [tunnel],
          }),
      },
    });
    await page.goto("/settings/general");
    await expect(agentPort(page)).toBeChecked();
    await expect(agentPort(page)).toBeDisabled();
    await expect(card(page).getByText("The agents' port stays open for now")).toBeVisible();
    await expect(card(page).getByText("You opened the panel on http://127.0.0.1:3000.", { exact: false })).toBeVisible();
  });

  test("keep-closed with the domain the only way in: the domain cannot change, and the card says so first", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "settings.panelAccess": () => access({ serveOnIp: false, onFailure: "stayClosed", actual: { ip: "closed", agentPort: "open" } }),
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/general");
    await expect(
      card(page).getByText("The domain is the only way in that works and IP access is set to stay closed, so it cannot change now."),
    ).toBeVisible();
    await expect(card(page).getByText("Removing or changing the domain reopens IP access at once")).toHaveCount(0);
    await card(page).getByLabel("Panel domain").fill("panel2.acme.dev");
    await expect(card(page).getByRole("button", { name: "Save domain" })).toBeDisabled();
    await card(page).getByLabel("Panel domain").press("Enter");
    expect(sent["settings.updateGeneral"]).toBeUndefined();
  });

  test("an admin sees the reasons and cannot choose keep-closed", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "settings.panelAccess": () =>
          access({
            blocked: [{ code: "notOwner", message: "Only the owner can turn this off." }],
            agentPortBlocked: [{ code: "notOwner", message: "Only the owner can turn this off." }],
          }),
      },
    });
    await page.goto("/settings/general");
    await expect(serveOnIp(page)).toBeDisabled();
    await expect(card(page).getByText("Only the owner can turn this off.")).toBeVisible();
    const choice = card(page).getByRole("radiogroup", { name: "If the domain stops working" });
    await expect(choice.getByRole("radio", { name: /Keep IP access closed/ })).toBeDisabled();
    await expect(choice.getByText("Only the owner can choose this, from a browser.")).toBeVisible();
  });
});
