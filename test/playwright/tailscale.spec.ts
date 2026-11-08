// Settings > Tailscale on the demo data (added in 0.2.1): every state of the
// server's Tailscale card, the Install button that opens the panel node's
// Shell tab with the command typed in (and never run), sign-in, the Serve
// switch with its URL and the entry the agent owns, and Lock to Tailscale,
// which only works from a page opened on the tailnet with the recovery
// commands saved. The ops are answered in the browser (demo/routes.ts, plus
// per-test overrides); the panel's own tests cover the server side.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { fixtures as settingsFixtures } from "./demo/settings";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/tailscale`;
mkdirSync(shots, { recursive: true });

const installCommand = "curl -fsSL https://tailscale.com/install.sh | sh";
const machine = "de-fsn-1.tail4f2a9c.ts.net";
const tailnetUrl = `https://${machine}`;

/** tailscale.get as the demo answers it (Running, Serve off), with changes. */
function status(changes: Input = {}): Input {
  return {
    detected: true,
    agentOnline: true,
    agentSupported: true,
    version: "1.104.5",
    minVersion: "1.104.4",
    versionOk: true,
    backendState: "Running",
    tailnet: "acme.dev",
    dnsName: machine,
    addresses: ["100.101.42.7", "fd7a:115c:a1e0::6a01:2a07"],
    loginName: "owner@acme.dev",
    tags: [],
    magicDns: true,
    https: true,
    acceptDns: false,
    exitNodeInUse: false,
    advertisesRoutes: false,
    keyExpiry: new Date(Date.now() + 150 * 86_400_000).toISOString(),
    disabledOnServer: false,
    serve: { wanted: false, tailnet: null, onOtherTailnet: false, state: "off", url: null, message: "", panelAnswers: false },
    owned: null,
    viaTailnet: false,
    canManage: true,
    installCommand,
    grantSnippet: '{\n  "grants": [{ "src": ["owner@acme.dev"], "dst": ["100.101.42.7"], "ip": ["tcp:443"] }]\n}',
    signInUrl: null,
    ...changes,
  };
}

const serving = (changes: Input = {}) =>
  status({
    serve: { wanted: true, tailnet: "acme.dev", onOtherTailnet: false, state: "active", url: tailnetUrl, message: "", panelAnswers: true },
    owned: { hostPort: `${machine}:443`, path: "/", proxy: "unix:/var/lib/seylo/panel/tailnet.sock" },
    ...changes,
  });

/** settings.general of the demo panel (panel.acme.dev active). */
const general = settingsFixtures["settings.general"] as Input;

/** settings.panelAccess while IP access is open and closing it is allowed. */
function panelAccess(changes: Input = {}): Input {
  return {
    serveOnIp: true,
    agentPortOpen: true,
    onFailure: "reopen",
    panelPort: 3000,
    agentPort: 3443,
    actual: { ip: "open", agentPort: "open" },
    privatePaths: [{ kind: "tailnet", url: tailnetUrl, working: true, since: new Date().toISOString(), usingNow: true }],
    blocked: [],
    agentPortBlocked: [],
    reclosesAt: null,
    lastChange: null,
    recovery: { sshTunnel: "ssh -L 3000:127.0.0.1:3000 root@203.0.113.10", cli: "sudo seylo panel ip-access on" },
    ...changes,
  };
}

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

function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test.describe("settings > tailscale", () => {
  test.use({ storageState: stateFile });

  test("the page is in the settings nav, next to Cloudflare", async ({ page }) => {
    await installDemo(page);
    await page.goto("/settings/cloudflare");
    await page.getByRole("link", { name: "Tailscale", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/tailscale$/);
    await expect(page.getByRole("heading", { name: "Tailscale", level: 1 })).toBeVisible();
  });

  test("not installed: the Install button opens the panel node's Shell tab with prefill, plus the command to copy", async ({ page }) => {
    const errors = pageErrors(page);
    await installDemo(page, {
      overrides: { "tailscale.get": () => status({ detected: false, version: null, backendState: null, tailnet: null, dnsName: null, addresses: [] }) },
    });
    await page.goto("/settings/tailscale");
    await expect(page.getByText("Not installed")).toBeVisible();
    const install = page.getByRole("link", { name: "Install on the server" });
    await expect(install).toHaveAttribute("href", new RegExp(`/nodes\\?.*node=${ids.de}`));
    const href = (await install.getAttribute("href")) ?? "";
    const search = new URL(href, "http://x").searchParams;
    expect(search.get("view")).toBe("shell");
    expect(search.get("prefill")).toBe("tailscale-install");
    await expect(page.getByText(installCommand).first()).toBeVisible();
    // Serve and Lock only show once Tailscale is there.
    await expect(page.getByRole("switch", { name: "Serve the panel on my tailnet" })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/not-installed.png` });
    expect(errors).toEqual([]);
  });

  test("the shell prefill types the install command once the shell is ready, without Enter", async ({ page }) => {
    const errors = pageErrors(page);
    await installDemo(page, {
      overrides: {
        "hostShell.status": () => ({
          nodeId: ids.de,
          enabled: true,
          available: true,
          canOpen: true,
          canEnable: true,
          maxSessions: 2,
          idleTimeoutSeconds: 900,
          sessions: [],
        }),
        "hostShell.open": () => ({
          url: "/api/streams/host-shell?t=demo",
          ticket: "demo",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          nodeId: ids.de,
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
        ws.send(Buffer.from(text, "utf8"));
      });
    });
    await page.goto(`/nodes?node=${ids.de}&view=shell&prefill=tailscale-install`);
    const sheet = page.getByRole("dialog");
    // The shell opens by itself and gets the command typed in.
    const terminal = sheet.getByRole("region", { name: "Root shell on de-fsn-1" }).last();
    await expect(terminal.getByText(installCommand).first()).toBeVisible();
    await expect.poll(() => typed.join("")).toBe(installCommand);
    expect(typed.join("")).not.toContain("\r");
    expect(typed.join("")).not.toContain("\n");
    await expect(sheet.getByText("The command is typed in the shell below.", { exact: false })).toBeVisible();
    // Typed once: the URL forgets it, so a reload does not type it again.
    await expect(page).not.toHaveURL(/prefill=/);
    await page.screenshot({ path: `${shots}/shell-prefill.png` });
    expect(errors).toEqual([]);
  });

  test("an unknown prefill types nothing and opens nothing", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "hostShell.status": () => ({
          nodeId: ids.de,
          enabled: true,
          available: true,
          canOpen: true,
          canEnable: true,
          maxSessions: 2,
          idleTimeoutSeconds: 900,
          sessions: [],
        }),
      },
    });
    let opened = false;
    await page.routeWebSocket(/\/api\/streams\/host-shell/, () => {
      opened = true;
    });
    await page.goto(`/nodes?node=${ids.de}&view=shell&prefill=${encodeURIComponent("rm -rf /")}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("button", { name: "Open root shell" })).toBeVisible();
    await expect(sheet.getByText("Install Tailscale")).toHaveCount(0);
    expect(opened).toBe(false);
  });

  test("host shells off: the install command is shown to run over SSH instead", async ({ page }) => {
    await installDemo(page);
    await page.goto(`/nodes?node=${ids.de}&view=shell&prefill=tailscale-install`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: "Host shells are off for this node" })).toBeVisible();
    await expect(sheet.getByText("Allow host shells to type it into a shell here, or run it over SSH:")).toBeVisible();
    await expect(sheet.getByText(installCommand)).toBeVisible();
  });

  test("not signed in: Sign in asks for the link and opens it in a new tab", async ({ page }) => {
    const errors = pageErrors(page);
    const loginUrl = "https://login.tailscale.com/a/1a2b3c4d5e6f";
    let signedIn = false;
    await installDemo(page, {
      overrides: {
        "tailscale.get": () =>
          status({ backendState: "NeedsLogin", tailnet: null, dnsName: null, addresses: [], loginName: null, signInUrl: signedIn ? loginUrl : null }),
        "tailscale.signIn": () => {
          signedIn = true;
          return { url: loginUrl, expiresAt: new Date(Date.now() + 600_000).toISOString() };
        },
      },
    });
    await page.addInitScript(() => {
      (window as unknown as { opened: string[] }).opened = [];
      window.open = ((url: string) => {
        (window as unknown as { opened: string[] }).opened.push(url);
        return null;
      }) as typeof window.open;
    });
    const sent = recordOps(page);
    await page.goto("/settings/tailscale");
    await expect(page.getByText("Not signed in")).toBeVisible();
    await expect(page.getByText("This puts the server on the tailnet you sign in to.", { exact: false })).toBeVisible();
    await expect(page.getByText("sudo tailscale up --accept-dns=false")).toBeVisible();
    await page.getByRole("button", { name: "Sign in to Tailscale" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([loginUrl]);
    expect(sent["tailscale.signIn"]).toEqual([{}]);
    await expect(page.getByRole("link", { name: "Open the sign-in link" })).toHaveAttribute("href", loginUrl);
    await expect(page.getByText("The link works for 10 minutes.", { exact: false })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("an admin sees the state but cannot sign the server in or turn Serve on", async ({ page }) => {
    await installDemo(page, {
      overrides: { "tailscale.get": () => status({ backendState: "NeedsLogin", canManage: false }) },
    });
    await page.goto("/settings/tailscale");
    await expect(page.getByText("Only the owner can sign the server in.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in to Tailscale" })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Serve the panel on my tailnet" })).toBeDisabled();
  });

  test("needs approval: a link to the admin console's Machines page", async ({ page }) => {
    await installDemo(page, { overrides: { "tailscale.get": () => status({ backendState: "NeedsMachineAuth" }) } });
    await page.goto("/settings/tailscale");
    await expect(page.getByText("Needs approval")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Machines in the admin console" })).toHaveAttribute(
      "href",
      "https://login.tailscale.com/admin/machines",
    );
    await expect(page.getByRole("switch", { name: "Serve the panel on my tailnet" })).toBeDisabled();
    await expect(page.getByText("Approve the machine in the Tailscale admin console first.")).toBeVisible();
  });

  test("running: the tailnet, the machine, key expiry, warnings, Turn off Tailscale DNS and the access rule", async ({ page }) => {
    const errors = pageErrors(page);
    let acceptDns = true;
    await installDemo(page, {
      overrides: {
        "tailscale.get": () => status({ acceptDns, https: false, exitNodeInUse: true }),
        "tailscale.setDns": () => {
          acceptDns = false;
          return status({ acceptDns, https: false, exitNodeInUse: true });
        },
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/tailscale");
    await expect(page.getByText(`Signed in to acme.dev as ${machine}`)).toBeVisible();
    await expect(page.getByText("100.101.42.7, fd7a:115c:a1e0::6a01:2a07")).toBeVisible();
    await expect(page.getByRole("link", { name: "Disable key expiry" })).toHaveAttribute("href", "https://login.tailscale.com/admin/machines");
    await expect(page.getByRole("link", { name: "Turn on HTTPS" })).toHaveAttribute("href", "https://login.tailscale.com/admin/dns");
    await expect(page.getByText("The server sends its traffic through an exit node.", { exact: false })).toBeVisible();
    await expect(page.getByText('"grants"', { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Turn off Tailscale DNS" }).click();
    await expect(page.getByText("Tailscale DNS is off on the server")).toBeVisible();
    expect(sent["tailscale.setDns"]).toEqual([{ acceptDns: false }]);
    await expect(page.getByRole("button", { name: "Turn off Tailscale DNS" })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/running.png`, fullPage: true });
    expect(errors).toEqual([]);
  });

  test("an agent that is too old, offline, or turned off on the server says so", async ({ page }) => {
    let answer = status({ agentSupported: false, detected: false });
    await installDemo(page, { overrides: { "tailscale.get": () => answer } });
    await page.goto("/settings/tailscale");
    await expect(page.getByText("The panel server's agent is too old to read Tailscale.", { exact: false })).toBeVisible();

    answer = status({ agentOnline: false });
    await page.reload();
    await expect(page.getByText("The panel server's agent is offline. This is what it reported last.")).toBeVisible();
    await expect(page.getByText("The panel server's agent is offline.", { exact: true })).toHaveCount(0);

    answer = status({ disabledOnServer: true });
    await page.reload();
    await expect(page.getByText("Tailscale for the panel is turned off on the server itself.", { exact: false })).toBeVisible();
    await expect(page.getByText("sudo seylo panel tailscale on").first()).toBeVisible();
    await expect(page.getByRole("switch", { name: "Serve the panel on my tailnet" })).toBeDisabled();
  });

  test("Serve on: the switch sends serve true, then the URL, Open and the entry the agent owns", async ({ page }) => {
    const errors = pageErrors(page);
    await installDemo(page);
    const sent = recordOps(page);
    await page.goto("/settings/tailscale");
    const toggle = page.getByRole("switch", { name: "Serve the panel on my tailnet" });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect.poll(() => sent["tailscale.setServe"]).toEqual([{ serve: true }]);
    await expect(toggle).toBeChecked();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open" }).first()).toHaveAttribute("href", tailnetUrl);
    await expect(page.getByText(`${machine}:443/ -> unix:/var/lib/seylo/panel/tailnet.sock`)).toBeVisible();
    // Not on the tailnet yet: no chip, and Lock says where to go.
    await expect(page.getByText("You are on the tailnet now")).toHaveCount(0);
    await expect(page.getByText(`Open ${tailnetUrl} on a device in your tailnet and sign in there`)).toBeVisible();
    await page.screenshot({ path: `${shots}/serving.png`, fullPage: true });

    await toggle.click();
    await expect.poll(() => sent["tailscale.setServe"]?.length).toBe(2);
    expect(sent["tailscale.setServe"]?.[1]).toEqual({ serve: false });
    await expect(toggle).not.toBeChecked();
    expect(errors).toEqual([]);
  });

  test("conflict and waiting states show the agent's words and what is missing", async ({ page }) => {
    let answer = serving({
      serve: { wanted: true, tailnet: "acme.dev", onOtherTailnet: false, state: "conflict", url: null, message: "Another handler serves de-fsn-1.tail4f2a9c.ts.net:443.", panelAnswers: false },
      owned: null,
    });
    await installDemo(page, { overrides: { "tailscale.get": () => answer } });
    await page.goto("/settings/tailscale");
    await expect(page.getByText("Another Serve entry uses this address")).toBeVisible();
    await expect(page.getByText("Another handler serves de-fsn-1.tail4f2a9c.ts.net:443.")).toBeVisible();

    answer = serving({ backendState: "Stopped", serve: { wanted: true, tailnet: "acme.dev", onOtherTailnet: false, state: "off", url: null, message: "", panelAnswers: false }, owned: null });
    await page.reload();
    await expect(page.getByText("Waiting for the server:", { exact: false })).toBeVisible();
    // Stopped is signed in: only the command that starts it, no sign-in.
    await expect(page.getByText("Tailscale is signed in but stopped on the server.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in to Tailscale" })).toHaveCount(0);
  });

  test("Serve off in keep-closed mode while it is the only way in asks to reopen IP access too", async ({ page }) => {
    let calls = 0;
    await installDemo(page, {
      overrides: {
        "tailscale.get": () => serving({ viaTailnet: true }),
        "settings.panelAccess": () => panelAccess({ serveOnIp: false, onFailure: "stayClosed", actual: { ip: "closed", agentPort: "open" } }),
      },
    });
    await page.route(/\/api\/v1\/tailscale\.setServe/, async (route) => {
      calls++;
      const input = route.request().postDataJSON() as Input;
      if (!input.reopenIpAccess) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "CONFLICT", message: "The tailnet is the only way into the panel right now.", details: { reason: "stayClosed" } } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tailscale: status(), reopenedUrl: "http://203.0.113.10:3000" }),
      });
    });
    await page.goto("/settings/tailscale");
    await page.getByRole("switch", { name: "Serve the panel on my tailnet" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Turn off Serve and reopen IP access?")).toBeVisible();
    await dialog.getByRole("button", { name: "Reopen and turn off" }).click();
    await expect(page.getByText("IP access reopened: http://203.0.113.10:3000")).toBeVisible();
    expect(calls).toBe(2);
  });

  test("Lock to Tailscale is disabled off the tailnet, even with the recovery commands saved", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "tailscale.get": () => serving(),
        "settings.panelAccess": () =>
          panelAccess({
            privatePaths: [{ kind: "tailnet", url: tailnetUrl, working: true, since: null, usingNow: false }],
            blocked: [{ code: "notOnPrivatePath", message: `You opened the panel on http://203.0.113.10:3000. Open ${tailnetUrl} and sign in there first.` }],
          }),
      },
    });
    await page.goto("/settings/tailscale");
    const lock = page.getByRole("button", { name: "Lock to Tailscale" });
    await expect(lock).toBeDisabled();
    await page.getByLabel("I saved these").check();
    await expect(lock).toBeDisabled();
    await expect(page.getByText(`You opened the panel on http://203.0.113.10:3000.`, { exact: false })).toBeVisible();
  });

  test("Lock to Tailscale on the tailnet: needs the tick, confirms, closes IP access and can remove the domain", async ({ page }) => {
    const errors = pageErrors(page);
    let access = panelAccess({
      agentPortBlocked: [{ code: "nodesOnAgentPort", message: "us-ash-1 connects over the agents' port.", nodeIds: [ids.us] }],
    });
    let domain: string | null = "panel.acme.dev";
    await installDemo(page, {
      overrides: {
        "tailscale.get": () => serving({ viaTailnet: true }),
        "settings.panelAccess": () => access,
        "settings.updatePanelAccess": (input) => {
          access = { ...access, ...input, actual: { ip: input.serveOnIp === false ? "closed" : "open", agentPort: "open" } };
          delete access.savedRecovery;
          return access;
        },
        "settings.general": () => ({ ...general, domain }),
        "settings.updateGeneral": (input) => {
          if (input.domain !== undefined) domain = input.domain;
          return { ...general, domain };
        },
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/tailscale");
    await expect(page.getByText("You are on the tailnet now")).toBeVisible();
    const checklist = page.getByRole("list", { name: "Lock to Tailscale" });
    await expect(checklist.getByText("You opened this page on the tailnet URL")).toBeVisible();
    await expect(checklist.getByText("The agents' port 3443 stays open: 1 node connects over it")).toBeVisible();
    await expect(page.getByText("ssh -L 3000:127.0.0.1:3000 root@203.0.113.10")).toBeVisible();
    await expect(page.getByText("sudo seylo panel ip-access on")).toBeVisible();
    await expect(page.getByText("GitHub webhooks cannot reach a panel on the tailnet only", { exact: false })).toBeVisible();

    const lock = page.getByRole("button", { name: "Lock to Tailscale" });
    await expect(lock).toBeDisabled();
    await page.getByLabel("I saved these").check();
    await page.getByLabel("Remove the panel domain panel.acme.dev").check();
    await expect(lock).toBeEnabled();
    await page.screenshot({ path: `${shots}/lock.png`, fullPage: true });
    await lock.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Lock the panel to Tailscale?")).toBeVisible();
    await expect(dialog.getByText("The panel restarts once, for a few seconds.", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: "Lock to Tailscale" }).click();
    await expect(page.getByText("The panel is locked to Tailscale")).toBeVisible();
    // The agents' port stays: another node uses it, so only IP access is sent.
    expect(sent["settings.updatePanelAccess"]).toEqual([{ serveOnIp: false }]);
    expect(sent["settings.updateGeneral"]).toEqual([{ domain: null }]);
    await expect(page.getByText("IP access is closed. The panel answers on the tailnet", { exact: false })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Lock also closes the agents' port when no other node uses it", async ({ page }) => {
    let access = panelAccess();
    await installDemo(page, {
      overrides: {
        "tailscale.get": () => serving({ viaTailnet: true }),
        "settings.panelAccess": () => access,
        "settings.updatePanelAccess": (input) => {
          access = { ...access, ...input, actual: { ip: "closed", agentPort: input.agentPortOpen === false ? "closed" : "open" } };
          return access;
        },
      },
    });
    const sent = recordOps(page);
    await page.goto("/settings/tailscale");
    await expect(page.getByText("The agents' port 3443 closes too: no other node connects over it")).toBeVisible();
    await page.getByLabel("I saved these").check();
    await page.getByRole("button", { name: "Lock to Tailscale" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Lock to Tailscale" }).click();
    await expect(page.getByText("The panel is locked to Tailscale")).toBeVisible();
    expect(sent["settings.updatePanelAccess"]).toEqual([{ serveOnIp: false, agentPortOpen: false }]);
    expect(sent["settings.updateGeneral"]).toBeUndefined();
  });
});
