// The installable app and push notifications (0.2.7). An admin turns them
// on in Settings > Notifications, only while the panel is reached on its
// own domain over HTTPS: browsers install apps and allow push only on a
// secure address, and an installed app stays tied to the address it was
// installed from (not an IP:port or tailnet address). Then each person
// picks, in their own settings, which alerts reach which of their devices.
// Pushes go through the browser maker's push service, encrypted for the
// device (RFC 8291), so that service cannot read them.

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";
import { type AlertEventName, type AlertRuleEventName, serviceAlertEvents } from "./alerts";

/**
 * Events a person can get as a push, in the order the settings list them.
 * The alert rule events (less update_available, which nothing raises yet)
 * and node_online, the good news after node_offline.
 */
export const pushEvents = [
  "crash",
  "crash_limit",
  "deploy_failed",
  "deploy_succeeded",
  "build_failed",
  "health_unhealthy",
  "certificate_failed",
  "uptime_down",
  "backup_failed",
  "cron_failed",
  "node_offline",
  "node_online",
  "node_health_check_failed",
  "disk_low",
  "cleanup_ran",
  "cleanup_failed",
  "update_failed",
  "approval_requested",
  "security_change",
] as const satisfies readonly AlertEventName[];
export type PushEventName = (typeof pushEvents)[number];
export const PushEvent = Type.Union(pushEvents.map((event) => Type.Literal(event)));

/** On for a person until they change their list: the problems, not the routine news. */
export const defaultPushEvents: readonly PushEventName[] = pushEvents.filter(
  (event) => !["deploy_succeeded", "cron_failed", "cleanup_ran", "cleanup_failed"].includes(event),
);

/**
 * Events a member can receive: their services' events, approvals they may
 * decide and their own account's security changes. Owners and admins can
 * receive every event (nodes, updates and panel access are theirs).
 */
export const memberPushEvents: readonly PushEventName[] = [
  ...(serviceAlertEvents satisfies readonly AlertRuleEventName[]),
  "approval_requested",
  "security_change",
];

/** Push services the panel sends to: the browser makers' (an endpoint anywhere else is refused). */
export const pushServiceHosts = [
  "fcm.googleapis.com",
  // Chrome Beta, Dev and Canary (and other non-stable Chromium builds) subscribe on Google's staging host.
  "jmt17.google.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "web.push.apple.com",
  "notify.windows.com",
] as const;

/** Whether an endpoint's host is one of the push services or a subdomain of one (WNS uses regional hosts). */
export function isPushServiceHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return pushServiceHosts.some((known) => host === known || host.endsWith(`.${known}`));
}

/** Why the admin switch cannot be turned on right now. */
export const appPushBlockCodes = ["noDomain", "domainNotActive", "notOnDomain", "viaTailnet", "notBrowser"] as const;
export const AppPushBlock = Type.Object({
  code: Type.Union(appPushBlockCodes.map((code) => Type.Literal(code))),
  message: Type.String(),
});
export type AppPushBlock = Static<typeof AppPushBlock>;

export const AppPushSettings = Type.Object({
  /** The admin switch. */
  enabled: Type.Boolean(),
  /** On and the panel domain working: the app installs and pushes go out. On but false: paused until the domain works again. */
  active: Type.Boolean(),
  /** "https://panel.example.com" once a panel domain is set; null without one. */
  domainUrl: Type.Union([Type.String(), Type.Null()]),
  /** This request came in on that domain over HTTPS (not IP:port, not the tailnet). */
  onDomainNow: Type.Boolean(),
  /** What refuses turning it on now; empty when it can be turned on (or is on). */
  blocks: Type.Array(AppPushBlock),
  /** People with at least one device, and their devices, on the current domain. */
  people: Type.Integer({ minimum: 0 }),
  devices: Type.Integer({ minimum: 0 }),
  changedAt: Type.Union([Timestamp, Type.Null()]),
  changedBy: Type.Union([Type.String(), Type.Null()]),
});
export type AppPushSettings = Static<typeof AppPushSettings>;

export const settings = defineOp({
  id: "push.settings",
  kind: "query",
  summary: "Get the app and push notifications setting",
  description:
    "Returns whether the installable app and push notifications are on, whether they work now (the panel domain must work over HTTPS), what refuses turning them on, and how many people and devices use them.",
  input: Empty,
  output: AppPushSettings,
  permission: permission.global("notifications.manage"),
  mcp: false,
  audit: false,
});

export const updateSettings = defineOp({
  id: "push.updateSettings",
  kind: "mutation",
  summary: "Turn the app and push notifications on or off",
  description:
    "Turns the installable app and push notifications on or off for everyone. Turning them on works only from a browser on the panel domain over HTTPS (CONFLICT with reason noDomain, domainNotActive, notOnDomain, viaTailnet or notBrowser otherwise). Turning them off removes every person's devices; they turn push on again on each device.",
  input: Type.Object({ enabled: Type.Boolean() }),
  output: AppPushSettings,
  permission: permission.global("notifications.manage"),
  mcp: false,
  audit: true,
});

export const PushDevice = Type.Object({
  id: Id,
  /** What the browser said it is, for example "Chrome on Android". */
  label: Type.String(),
  /** The push service's host, for example "fcm.googleapis.com". */
  service: Type.String(),
  /** SHA-256 of the endpoint, hex: lets a browser find its own row without the endpoint leaving it. */
  endpointHash: Type.String(),
  createdAt: Timestamp,
  lastSentAt: Type.Union([Timestamp, Type.Null()]),
  /** The last send failed (the device is removed after 5 failures in a row or when the push service says it is gone). */
  failing: Type.Boolean(),
  lastError: Type.Union([Type.String(), Type.Null()]),
});
export type PushDevice = Static<typeof PushDevice>;

export const MyPush = Type.Object({
  /** The admin switch is on (pushes may still be paused while the domain does not work). */
  enabled: Type.Boolean(),
  /** An admin turned the app and push notifications on and the panel domain works. */
  available: Type.Boolean(),
  /** Why it is not available, for the page to say; empty when it is. */
  reason: Type.String(),
  /** "https://panel.example.com" while available: devices can only be added from there. */
  domainUrl: Type.Union([Type.String(), Type.Null()]),
  /** This request came in on the domain over HTTPS. */
  onDomainNow: Type.Boolean(),
  /** The panel's VAPID public key (base64url) for pushManager.subscribe; null while not available. */
  publicKey: Type.Union([Type.String(), Type.Null()]),
  devices: Type.Array(PushDevice),
  /** The events this person gets. */
  events: Type.Array(PushEvent),
  /** The events this person can get (members: their services, approvals they decide, their own account). */
  eventChoices: Type.Array(PushEvent),
});
export type MyPush = Static<typeof MyPush>;

export const mine = defineOp({
  id: "push.mine",
  kind: "query",
  summary: "Get your push notification devices and events",
  description:
    "Returns whether push notifications are available, the signed-in person's devices and which alert events reach them. Browser sessions and full API keys of that person only.",
  input: Empty,
  output: MyPush,
  permission: permission.account(),
  mcp: false,
  audit: false,
});

export const subscribe = defineOp({
  id: "push.subscribe",
  kind: "mutation",
  summary: "Add this device for push notifications",
  description:
    "Adds a browser's push subscription (subscription.toJSON()) to the signed-in person's devices. Only from a browser session on the panel domain over HTTPS while push is on. The endpoint must be a known push service (Google, Mozilla, Apple, Microsoft). A subscription already on another account moves to this one.",
  input: Type.Object({
    endpoint: Type.String({ minLength: 12, maxLength: 2048, pattern: "^https://" }),
    p256dh: Type.String({ minLength: 80, maxLength: 120, pattern: "^[A-Za-z0-9_-]+={0,2}$" }),
    auth: Type.String({ minLength: 16, maxLength: 32, pattern: "^[A-Za-z0-9_-]+={0,2}$" }),
    label: Type.String({ minLength: 1, maxLength: 80 }),
  }),
  output: PushDevice,
  permission: permission.account(),
  // The endpoint and keys are what lets anyone push to the device.
  sensitive: { input: ["endpoint", "p256dh", "auth"] },
  mcp: false,
  audit: true,
});

export const removeDevice = defineOp({
  id: "push.removeDevice",
  kind: "mutation",
  summary: "Remove a push notification device",
  description: "Removes one of the signed-in person's devices; it gets no more pushes.",
  input: Type.Object({ deviceId: Id }),
  output: Type.Object({ removed: Type.Boolean() }),
  permission: permission.account(),
  mcp: false,
  audit: true,
});

export const setEvents = defineOp({
  id: "push.setEvents",
  kind: "mutation",
  summary: "Choose which alerts reach your devices",
  description:
    "Sets the alert events that reach the signed-in person's devices. Events the person cannot receive (see eventChoices in push.mine) are refused.",
  input: Type.Object({ events: Type.Array(PushEvent, { maxItems: 64, uniqueItems: true }) }),
  output: Type.Object({ events: Type.Array(PushEvent) }),
  permission: permission.account(),
  mcp: false,
  audit: true,
});

export const test = defineOp({
  id: "push.test",
  kind: "mutation",
  summary: "Send a test push to your devices",
  description: "Sends a test notification to each of the signed-in person's devices and says which ones took it.",
  input: Empty,
  output: Type.Object({
    results: Type.Array(
      Type.Object({ deviceId: Id, label: Type.String(), ok: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]) }),
    ),
  }),
  permission: permission.account(),
  mcp: false,
  audit: true,
});
