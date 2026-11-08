import { expect, test } from "bun:test";
import { nodes, settings } from "@seylo/ops";
import { renderStatic } from "../../test/render";
import { PanelDomainCard } from "./panel-access-card";

const general = {
  name: "Acme",
  domain: "panel.acme.dev",
  domainStatus: { state: "active" as const, message: "" },
  defaultNodeId: null,
  publicUrl: "https://panel.acme.dev",
  uptimeAllowInternalTargets: false,
  auditRetentionDays: null,
  domainNodes: [],
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

const render = (state: Record<string, unknown>) =>
  renderStatic(
    () => <PanelDomainCard general={general} />,
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
