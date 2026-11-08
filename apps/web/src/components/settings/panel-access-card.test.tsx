import { expect, test } from "bun:test";
import { nodes, settings } from "@seylo/ops";
import { renderStatic } from "../../test/render";
import { PanelDomainCard } from "./panel-access-card";

type General = Parameters<typeof PanelDomainCard>[0]["general"];

const general: General = {
  name: "Acme",
  domain: "panel.acme.dev",
  domainStatus: { state: "active", message: "", checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(), proxied: false },
  defaultNodeId: null,
  publicUrl: "https://panel.acme.dev",
  uptimeAllowInternalTargets: false,
  auditRetentionDays: null,
};

const access = (over: Record<string, unknown> = {}) => ({
  serveOnIp: true,
  agentPortOpen: true,
  onFailure: "reopen",
  panelPort: 8080,
  agentPort: 3443,
  actual: { ip: "open", agentPort: "open" },
  privatePaths: [{ kind: "domain", url: "https://panel.acme.dev", working: true, since: null, usingNow: true }],
  blocked: [],
  agentPortBlocked: [],
  reclosesAt: null,
  openReason: null,
  oldDocker: null,
  lastChange: null,
  recovery: { sshTunnel: "ssh -L 3000:127.0.0.1:8080 root@203.0.113.10", cli: "sudo seylo panel ip-access on" },
  ...over,
});

const panelNode = {
  id: "node00000000000a",
  name: "de-fsn-1",
  isPanelNode: true,
  publicAddress: null,
  publicIpv4: "203.0.113.10",
  publicIpv6: null,
};

const render = (state: Record<string, unknown>, data: General = general) =>
  renderStatic(
    () => <PanelDomainCard general={data} />,
    [
      [settings.panelAccess, {}, state],
      [nodes.list, {}, { nodes: [panelNode] }],
    ],
  );

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

test("open over the domain: the switches, the real IP:port and the recovery commands", async () => {
  const out = text(await render(access()));
  expect(out).toContain("Serve on IP address");
  expect(out).toContain("Off: http://203.0.113.10:8080 only answers on the server itself (127.0.0.1).");
  expect(out).toContain("You are here");
  expect(out).toContain("Turn off Serve on IP address first.");
  expect(out).toContain("ssh -L 3000:127.0.0.1:8080 root@203.0.113.10");
  expect(out).toContain("sudo seylo panel ip-access on");
  expect(out).not.toContain("Can't turn it off yet");
});

test("blocked: the panel's reasons are listed", async () => {
  const out = text(
    await render(
      access({
        privatePaths: [{ kind: "domain", url: "https://panel.acme.dev", working: true, since: null, usingNow: false }],
        blocked: [{ code: "notOnPrivatePath", message: "You opened the panel on http://203.0.113.10:8080. Open https://panel.acme.dev." }],
      }),
    ),
  );
  expect(out).toContain("Can't turn it off yet");
  expect(out).toContain("You opened the panel on http://203.0.113.10:8080.");
});

test("closed, reopened by itself, and no agents' port", async () => {
  const closed = text(
    await render(
      access({
        serveOnIp: false,
        agentPortOpen: false,
        actual: { ip: "closed", agentPort: "closed" },
        lastChange: { at: new Date().toISOString(), reason: "Serve on IP address turned off in Settings", by: "you@acme.dev" },
      }),
    ),
  );
  expect(closed).toContain("IP access is closed: http://203.0.113.10:8080 only answers on the server.");
  expect(closed).toContain("The agents' port is closed");
  expect(closed).toContain("(you@acme.dev)");

  const reopened = text(
    await render(
      access({
        serveOnIp: false,
        reclosesAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        lastChange: { at: new Date().toISOString(), reason: "the panel domain panel.acme.dev stopped working", by: "system" },
      }),
    ),
  );
  expect(reopened).toContain("IP access is open again: the panel domain panel.acme.dev stopped working.");
  expect(reopened).toContain("It closes again in 30 minutes");

  const noPort = text(await render(access({ agentPort: null })));
  expect(noPort).toContain("This panel has no agents' port");

  const rolling = text(await render(access({ serveOnIp: false, actual: { ip: "unknown", agentPort: "open" } })));
  expect(rolling).toContain("The panel restarts to apply this.");
});

test("the domain's state: when it was checked, Check now and Cloudflare's proxy", async () => {
  const active = text(await render(access()));
  expect(active).toContain("Active");
  expect(active).toContain("Checked 5 min ago");
  expect(active).toContain("Check now");
  expect(active).not.toContain("Proxied by Cloudflare");

  const message =
    "panel.acme.dev is proxied by Cloudflare, and https://panel.acme.dev does not answer through it yet. In Cloudflare, point the record at 203.0.113.10, set SSL/TLS to Full (strict) and turn off Always Use HTTPS: Let's Encrypt gets the certificate over http://panel.acme.dev/.well-known/acme-challenge/, and the panel redirects to HTTPS itself.";
  const proxied = text(
    await render(access(), {
      ...general,
      domainStatus: { state: "issuing_certificate", message, checkedAt: new Date().toISOString(), proxied: true },
    }),
  );
  expect(proxied).toContain("Getting a certificate");
  expect(proxied).toContain("Proxied by Cloudflare");
  expect(proxied).toContain("Checked just now");
  expect(proxied).toContain("set SSL/TLS to Full (strict) and turn off Always Use HTTPS");

  // Nothing to check without a domain, and no time before the first check.
  const none = text(
    await render(access({ privatePaths: [] }), {
      ...general,
      domain: null,
      domainStatus: { state: "none", message: "", checkedAt: null, proxied: false },
    }),
  );
  expect(none).toContain("No domain");
  expect(none).not.toContain("Check now");
  expect(none).not.toContain("Checked");
});

test("kept open by a node on plain http://: the panel's reason, not the old reopen", async () => {
  const out = text(
    await render(
      access({
        serveOnIp: false,
        openReason: "node b2 connects over http://203.0.113.5:3000 and closing would cut it off",
        lastChange: { at: new Date().toISOString(), reason: "the panel domain panel.acme.dev stopped working", by: "system" },
      }),
    ),
  );
  expect(out).toContain("IP access is open again: node b2 connects over http://203.0.113.5:3000 and closing would cut it off.");
  expect(out).not.toContain("stopped working");
});

test("Docker older than 28 on the panel's server: the card warns while IP access is off", async () => {
  const warning =
    "The panel's server runs Docker 26.1.4. Before Docker 28, machines on the same local network may still reach ports on 127.0.0.1.";
  const closed = text(await render(access({ serveOnIp: false, oldDocker: "26.1.4", actual: { ip: "closed", agentPort: "open" } })));
  expect(closed).toContain(warning);
  // Open on every address, the warning is the confirm dialog's (not rendered here).
  expect(text(await render(access({ oldDocker: "26.1.4" })))).not.toContain(warning);
});
