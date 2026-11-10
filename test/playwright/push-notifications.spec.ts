// The installable app and push notifications (0.2.7) on the demo data:
// the admin card on Settings > Notifications explains what it is for, keeps
// its switch disabled with the panel's reasons until the page is on the
// panel domain over HTTPS, turns on and asks before turning off; a
// person's Push notifications page says why it is not available, sends
// them to the domain from anywhere else, and on the domain turns push on
// for this browser (permission, the real service worker, a stubbed push
// subscription), lists the device, sends a test, saves the event choices
// and turns it off again. Screenshots go to $SHOTS_DIR/push/.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

test.use({ storageState: stateFile });

const shots = `${process.env.SHOTS_DIR ?? "test/playwright/shots"}/push`;
const elsewhere = "https://panel.example.com";
const endpoint = "https://fcm.googleapis.com/fcm/send/demo-device";
const publicKey = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 9)]).toString("base64url");
type Calls = { op: string; input: Record<string, any> }[];

/** Push in the browser without a push service: permission granted, subscribe hands back a fixed subscription. */
async function stubPushApi(page: Page) {
  await page.addInitScript(() => {
    let permission: NotificationPermission = "default";
    Object.defineProperty(Notification, "permission", { get: () => permission });
    Notification.requestPermission = async () => {
      permission = "granted";
      return permission;
    };
    let subscription: PushSubscription | null = null;
    const bytes = (n: number, first?: number) => {
      const out = new Uint8Array(n).fill(7);
      if (first !== undefined) out[0] = first;
      return out.buffer;
    };
    PushManager.prototype.getSubscription = async () => subscription;
    PushManager.prototype.subscribe = async (options?: PushSubscriptionOptionsInit) => {
      const key = options?.applicationServerKey as Uint8Array;
      subscription = {
        endpoint: "https://fcm.googleapis.com/fcm/send/demo-device",
        options: { applicationServerKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength), userVisibleOnly: true },
        getKey: (name: string) => (name === "p256dh" ? bytes(65, 4) : bytes(16)),
        unsubscribe: async () => {
          subscription = null;
          return true;
        },
      } as unknown as PushSubscription;
      return subscription;
    };
  });
}

interface World {
  settings: Record<string, any>;
  mine: Record<string, any>;
  calls: Calls;
}

async function open(page: Page, path: string, world: World) {
  const record = (op: string, input: Record<string, any>) => world.calls.push({ op, input });
  await installDemo(page, {
    nodeLive: "silent",
    overrides: {
      "system.features": () => ({
        githubSignIn: { enabled: false, reason: "off" },
        passkeys: { enabled: true, reason: "" },
        mcp: { enabled: true, reason: "" },
        ai: { enabled: false, reason: "off" },
        telemetry: { enabled: false, reason: "off" },
        notifications: { enabled: true, reason: "" },
        appPush: { enabled: world.mine.available, reason: world.mine.reason },
      }),
      "push.settings": () => world.settings,
      "push.updateSettings": (input) => {
        record("push.updateSettings", input);
        world.settings = { ...world.settings, enabled: input.enabled, active: input.enabled, devices: input.enabled ? world.settings.devices : 0 };
        return world.settings;
      },
      "push.mine": () => world.mine,
      "push.subscribe": (input) => {
        record("push.subscribe", input);
        const device = {
          id: "dev000000000001",
          label: input.label,
          service: "fcm.googleapis.com",
          endpointHash: createHash("sha256").update(input.endpoint).digest("hex"),
          createdAt: new Date().toISOString(),
          lastSentAt: null,
          failing: false,
          lastError: null,
        };
        world.mine = { ...world.mine, devices: [device] };
        return device;
      },
      "push.removeDevice": (input) => {
        record("push.removeDevice", input);
        world.mine = { ...world.mine, devices: [] };
        return { removed: true };
      },
      "push.setEvents": (input) => {
        record("push.setEvents", input);
        world.mine = { ...world.mine, events: input.events };
        return { events: input.events };
      },
      "push.test": () => {
        record("push.test", {});
        return { results: world.mine.devices.map((d: { id: string; label: string }) => ({ deviceId: d.id, label: d.label, ok: true, error: null })) };
      },
    },
  });
  await page.goto(path);
}

function adminSettings(overrides: Record<string, any> = {}) {
  return {
    enabled: false,
    active: false,
    domainUrl: elsewhere,
    onDomainNow: false,
    blocks: [{ code: "notOnDomain", message: `This page is not open on the panel domain. Open the panel at ${elsewhere} to turn this on.` }],
    people: 0,
    devices: 0,
    changedAt: null,
    changedBy: null,
    ...overrides,
  };
}

function myPush(overrides: Record<string, any> = {}) {
  return {
    enabled: true,
    available: true,
    reason: "",
    domainUrl: elsewhere,
    onDomainNow: false,
    publicKey,
    devices: [],
    events: ["crash", "deploy_failed"],
    eventChoices: ["crash", "deploy_failed", "deploy_succeeded", "node_offline", "node_online"],
    ...overrides,
  };
}

const card = (page: Page) => page.locator("section, [data-slot=card]").filter({ has: page.getByRole("heading", { name: "App and push notifications" }) }).first();

test("the admin card explains the app and push, and keeps the switch off-limits away from the domain", async ({ page }) => {
  const world: World = { settings: adminSettings(), mine: myPush({ enabled: false, available: false, reason: "off" }), calls: [] };
  await open(page, "/settings/notifications", world);
  await expect(page.getByRole("heading", { name: "App and push notifications" })).toBeVisible();
  await expect(page.getByText("A node that went offline or came back", { exact: false })).toBeVisible();
  await expect(page.getByText("encrypted for each device", { exact: false })).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Turn on the app and push notifications" });
  await expect(toggle).toBeDisabled();
  await expect(page.getByText("Needs the panel on its own domain over HTTPS")).toBeVisible();
  await expect(page.getByText(world.settings.blocks[0].message)).toBeVisible();
  await expect(page.getByRole("link", { name: `Open ${elsewhere}` })).toHaveAttribute("href", `${elsewhere}/settings/notifications`);
  mkdirSync(shots, { recursive: true });
  await card(page).screenshot({ path: `${shots}/admin-blocked.png` });
  expect(world.calls).toEqual([]);
});

test("on the domain the switch turns on, and turning off asks first when people have devices", async ({ page }) => {
  const world: World = {
    settings: adminSettings({ domainUrl: "https://panel.example.com", onDomainNow: true, blocks: [] }),
    mine: myPush({ enabled: false, available: false, reason: "off" }),
    calls: [],
  };
  await open(page, "/settings/notifications", world);
  const toggle = page.getByRole("switch", { name: "Turn on the app and push notifications" });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(page.getByText("The app and push notifications are on").first()).toBeVisible();
  expect(world.calls).toEqual([{ op: "push.updateSettings", input: { enabled: true } }]);
  await expect(page.getByText(`On. People can install the app from ${elsewhere}`, { exact: false })).toBeVisible();
  await card(page).screenshot({ path: `${shots}/admin-on.png` });

  world.settings = { ...world.settings, people: 2, devices: 3 };
  await page.reload();
  await page.getByRole("switch", { name: "Turn on the app and push notifications" }).click();
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  await expect(dialog.getByText("Turn off the app and push notifications?")).toBeVisible();
  await dialog.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("The app and push notifications are off").first()).toBeVisible();
  expect(world.calls.at(-1)).toEqual({ op: "push.updateSettings", input: { enabled: false } });
});

test("Push notifications is under Your account and says why it is not available", async ({ page }) => {
  const reason = "An admin has not turned on the app and push notifications (Settings > Notifications).";
  const world: World = { settings: adminSettings(), mine: myPush({ enabled: false, available: false, reason, publicKey: null }), calls: [] };
  await open(page, "/settings/profile", world);
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Push notifications" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Push notifications" })).toBeVisible();
  await expect(page.getByText("Push notifications are not on")).toBeVisible();
  await expect(page.getByText(reason)).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn on" })).toHaveCount(0);
});

test("away from the domain the page sends you there", async ({ page }) => {
  const world: World = { settings: adminSettings(), mine: myPush(), calls: [] };
  await open(page, "/settings/push", world);
  await expect(page.getByText(`Push notifications work on ${elsewhere}`, { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open panel.example.com" })).toHaveAttribute("href", `${elsewhere}/settings/push`);
  await expect(page.getByRole("button", { name: "Turn on" })).toHaveCount(0);
  // The event choices still save from here.
  await expect(page.getByRole("switch", { name: "Crash" })).toBeChecked();
});

test("on the domain: turn push on for this browser, see it listed, send a test, pick events, turn it off", async ({ page }) => {
  await stubPushApi(page);
  const world: World = { settings: adminSettings(), mine: myPush(), calls: [] };
  // The demo's own address stands in for the panel domain (loopback is a secure context too).
  await installDemo(page, { nodeLive: "silent" });
  await page.goto("/");
  world.mine = myPush({ domainUrl: new URL(page.url()).origin, onDomainNow: true });
  await open(page, "/settings/push", world);

  await expect(page.getByText("Off on this device.")).toBeVisible();
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("Push notifications are on for this device").first()).toBeVisible();
  const subscribe = world.calls.find((c) => c.op === "push.subscribe");
  expect(subscribe?.input.endpoint).toBe(endpoint);
  expect(subscribe?.input.p256dh).toHaveLength(87);
  expect(subscribe?.input.auth).toHaveLength(22);
  expect(subscribe?.input.label).toMatch(/^Chrome on /);
  // The real service worker took the page.
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/"))?.active?.scriptURL ?? "")).toMatch(/\/sw\.js$/);
  // The manifest and home screen tags are linked on the domain.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");

  const devices = page.getByRole("list", { name: "Your devices" });
  await expect(devices.getByText("This device")).toBeVisible();
  await expect(page.getByText("On. The alerts you pick below reach this device.")).toBeVisible();
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/mine-on.png`, fullPage: true });

  await page.getByRole("button", { name: "Send a test" }).click();
  await expect(page.getByText("Test sent to 1 device").first()).toBeVisible();

  await page.getByRole("switch", { name: "Deploy succeeded" }).click();
  await expect.poll(() => world.calls.filter((c) => c.op === "push.setEvents").at(-1)?.input.events).toEqual([
    "crash",
    "deploy_failed",
    "deploy_succeeded",
  ]);
  await expect(page.getByRole("switch", { name: "Node back online" })).toBeVisible();

  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("Push notifications are off for this device").first()).toBeVisible();
  expect(world.calls.find((c) => c.op === "push.removeDevice")?.input).toEqual({ deviceId: "dev000000000001" });
  await expect(page.getByText("Off on this device.")).toBeVisible();
});
