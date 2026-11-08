import { expect, test } from "bun:test";
import { nodes, settings } from "@seylo/ops";
import { renderStatic } from "../../../test/render";
import { LockChecklist } from "./lock-checklist";
import { ServeSwitch } from "./serve-switch";
import type { TailscaleStatus } from "./shared";
import { StatusCard } from "./status-card";

const machine = "de-fsn-1.tail4f2a9c.ts.net";
const tailnetUrl = `https://${machine}`;

/** tailscale.get: Running, Serve on and answering, opened on the tailnet. */
function status(changes: Partial<TailscaleStatus> = {}): TailscaleStatus {
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
    addresses: ["100.101.42.7"],
    loginName: "owner@acme.dev",
    tags: [],
    magicDns: true,
    https: true,
    acceptDns: false,
    exitNodeInUse: false,
    advertisesRoutes: false,
    keyExpiry: null,
    disabledOnServer: false,
    serve: { wanted: true, tailnet: "acme.dev", onOtherTailnet: false, state: "active", url: tailnetUrl, message: "", panelAnswers: true },
    owned: null,
    viaTailnet: true,
    canManage: true,
    installCommand: "curl -fsSL https://tailscale.com/install.sh | sh",
    grantSnippet: "",
    signInUrl: null,
    ...changes,
  };
}

/** settings.panelAccess of a panel installed with --port 8080, open, closing allowed. */
function access(changes: Record<string, unknown> = {}) {
  return {
    serveOnIp: true,
    agentPortOpen: true,
    onFailure: "reopen",
    panelPort: 8080,
    agentPort: 3443,
    actual: { ip: "open", agentPort: "open" },
    privatePaths: [{ kind: "tailnet", url: tailnetUrl, working: true, since: null, usingNow: true }],
    blocked: [],
    agentPortBlocked: [],
    reclosesAt: null,
    lastChange: null,
    recovery: { sshTunnel: "ssh -L 3000:127.0.0.1:8080 root@203.0.113.10", cli: "sudo seylo panel ip-access on" },
    ...changes,
  };
}

const general = {
  name: "Acme",
  domain: null,
  domainStatus: { state: "none", message: "" },
  defaultNodeId: null,
  publicUrl: "http://203.0.113.10:8080",
  uptimeAllowInternalTargets: false,
  auditRetentionDays: null,
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

const lock = (tailscaleStatus: TailscaleStatus, panelAccess: Record<string, unknown>) =>
  renderStatic(
    () => <LockChecklist status={tailscaleStatus} />,
    [
      [settings.panelAccess, {}, panelAccess],
      [settings.general, {}, general],
    ],
  );

/** The <button> whose text is `label`, as rendered. */
const button = (html: string, label: string) => {
  const match = new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`).exec(html);
  if (!match) throw new Error(`no button "${label}"`);
  return match[0];
};
const disabled = (html: string, label: string) => /^<button[^>]*\sdisabled=""/.test(button(html, label));

test("Lock: the SSH tunnel's local end is 3000 whatever the panel's port", async () => {
  const out = text(await lock(status(), access()));
  expect(out).toContain("SSH tunnel, then open http://127.0.0.1:3000");
  expect(out).not.toContain("http://127.0.0.1:8080");
  expect(out).toContain("ssh -L 3000:127.0.0.1:8080 root@203.0.113.10");
});

test("Lock: every row says to a screen reader whether it is done, not yet, or a change", async () => {
  const ready = text(await lock(status(), access()));
  expect(ready).toContain("Done: Tailscale runs on the server");
  expect(ready).toContain(`Done: Serve answers on ${tailnetUrl}`);
  expect(ready).toContain("Done: You opened this page on the tailnet URL");
  expect(ready).toContain("Changes: Serve on IP address turns off");
  expect(ready).toContain("Changes: The agents' port 3443 closes too");

  const notYet = text(
    await lock(
      status({
        backendState: "Stopped",
        viaTailnet: false,
        serve: { wanted: true, tailnet: "acme.dev", onOtherTailnet: false, state: "active", url: tailnetUrl, message: "", panelAnswers: false },
      }),
      access(),
    ),
  );
  expect(notYet).toContain("Not yet: Tailscale does not run on the server yet");
  expect(notYet).toContain(`Not yet: Serve does not answer on ${tailnetUrl} yet`);
  expect(notYet).toContain(`Not yet: Open ${tailnetUrl} on a device in your tailnet`);
  expect(notYet).not.toContain("Tailscale runs on the server");
  expect(notYet).not.toContain(`Serve answers on ${tailnetUrl}`);

  const noUrl = text(await lock(status({ serve: { wanted: true, tailnet: "acme.dev", onOtherTailnet: false, state: "off", url: null, message: "", panelAnswers: false } }), access()));
  expect(noUrl).toContain("Not yet: Serve does not answer yet");
});

test("Locked: a change that still rolls out says the panel restarts, not that IP access is open", async () => {
  const lastChange = { at: new Date().toISOString(), reason: "Serve on IP address turned off in Settings", by: "you@acme.dev" };
  const rolling = text(await lock(status(), access({ serveOnIp: false, actual: { ip: "unknown", agentPort: "unknown" }, lastChange })));
  expect(rolling).toContain("The panel restarts to apply this.");
  expect(rolling).not.toContain("IP access is open right now");
  expect(rolling).not.toContain("Serve on IP address turned off in Settings");

  const open = text(await lock(status(), access({ serveOnIp: false, lastChange })));
  expect(open).toContain("Serve on IP address is off, but IP access is open right now.");
  expect(open).toContain("Serve on IP address turned off in Settings");

  const closed = text(await lock(status(), access({ serveOnIp: false, actual: { ip: "closed", agentPort: "closed" }, lastChange })));
  expect(closed).toContain("IP access is closed. The panel answers on the tailnet.");
});

const card = (tailscaleStatus: TailscaleStatus) =>
  renderStatic(() => <StatusCard status={tailscaleStatus} />, [[nodes.list, {}, { nodes: [] }]]);

test("Starting: the card says connecting, not signed in, and Serve waits for it", async () => {
  const starting = status({
    backendState: "Starting",
    serve: { wanted: false, tailnet: null, onOtherTailnet: false, state: "off", url: null, message: "", panelAnswers: false },
  });
  const out = text(await card(starting));
  expect(out).toContain("Connecting");
  expect(out).toContain("has not reached the tailnet yet");
  expect(out).not.toContain("Signed in to acme.dev");
  expect(out).not.toContain("Sign in to Tailscale");

  const serve = text(await renderStatic(() => <ServeSwitch status={starting} />));
  expect(serve).toContain("Wait until Tailscale on the server is connected.");
  expect(serve).not.toContain("Sign the server in to Tailscale first.");

  const signedOut = text(await renderStatic(() => <ServeSwitch status={{ ...starting, backendState: "NeedsLogin" }} />));
  expect(signedOut).toContain("Sign the server in to Tailscale first.");
});

test("an offline agent: Sign in and Turn off Tailscale DNS are there but disabled", async () => {
  const signIn = await card(status({ agentOnline: false, backendState: "NeedsLogin" }));
  expect(text(signIn)).toContain("This is what it reported last.");
  expect(disabled(signIn, "Sign in to Tailscale")).toBe(true);
  expect(disabled(await card(status({ backendState: "NeedsLogin" })), "Sign in to Tailscale")).toBe(false);

  const dns = await card(status({ agentOnline: false, acceptDns: true }));
  expect(disabled(dns, "Turn off Tailscale DNS")).toBe(true);
  expect(disabled(await card(status({ acceptDns: true })), "Turn off Tailscale DNS")).toBe(false);
});
