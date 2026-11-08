import { expect, test } from "bun:test";
import { renderStatic } from "../../../test/render";
import { ServeSwitch } from "./serve-switch";
import { isSignedOut, serveBlockedReason, type TailscaleStatus } from "./shared";
import { StatusCard } from "./status-card";

const machine = "de-fsn-1.tail4f2a9c.ts.net";

const status = (over: Partial<TailscaleStatus> = {}): TailscaleStatus => ({
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
  serve: { wanted: false, tailnet: null, onOtherTailnet: false, state: "off", url: null, message: "", panelAnswers: false },
  owned: null,
  viaTailnet: false,
  canManage: true,
  installCommand: "curl -fsSL https://tailscale.com/install.sh | sh",
  grantSnippet: "",
  signInUrl: null,
  ...over,
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

test("stopped: signed in, so no sign-in button, only the command that starts it on the server", async () => {
  const stopped = status({ backendState: "Stopped" });
  const out = text(await renderStatic(() => <StatusCard status={stopped} />));
  expect(out).toContain("Stopped");
  expect(out).toContain("Tailscale is signed in but stopped on the server.");
  expect(out).toContain("sudo tailscale up --accept-dns=false");
  expect(out).not.toContain("Sign in to Tailscale");
  expect(isSignedOut(stopped)).toBe(false);

  // Signed out still gets the button.
  const signedOut = text(
    await renderStatic(() => <StatusCard status={status({ backendState: "NeedsLogin", tailnet: null, dnsName: null })} />),
  );
  expect(signedOut).toContain("Sign in to Tailscale");

  // The Serve switch asks to start it, not to sign in.
  expect(serveBlockedReason(stopped)).toBe("notSignedIn");
  const serve = text(await renderStatic(() => <ServeSwitch status={stopped} />));
  expect(serve).toContain("Start Tailscale on the server first.");
  expect(serve).not.toContain("Sign the server in");
});

test("Serve on another tailnet: both tailnets, and only the owner gets the button to serve the panel there", async () => {
  const moved = status({
    tailnet: "work.example",
    dnsName: "de-fsn-1.tail9999.ts.net",
    serve: { wanted: true, tailnet: "acme.dev", onOtherTailnet: true, state: "off", url: null, message: "", panelAnswers: false },
  });
  const out = text(await renderStatic(() => <ServeSwitch status={moved} />));
  expect(out).toContain("The server is on another tailnet");
  expect(out).toContain("Serve was turned on for acme.dev, and the server is now signed in to work.example.");
  expect(out).toContain("Serve on work.example");
  expect(out).not.toContain("Waiting for the server");

  const admin = text(await renderStatic(() => <ServeSwitch status={{ ...moved, canManage: false }} />));
  expect(admin).not.toContain("Serve on work.example");
  expect(admin).toContain("Only the owner can serve the panel on work.example.");
});
