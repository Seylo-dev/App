// The installable app and push notifications in the browser (0.2.7). While
// an admin has them on and this tab is on the panel domain over HTTPS, the
// page links the manifest and the home screen tags, and registers the
// service worker (public/sw.js), which only shows pushes and opens their
// pages. Anywhere else (IP:port, the tailnet) nothing is linked: an app or
// a subscription made there would be tied to that address.
//
// A device is added only when the person turns push on (Settings > Push
// notifications). A subscription this browser still holds but the panel no
// longer has (removed from another device, the session ended, push turned
// off) is dropped here, never added again behind the person's back.

import type { push } from "@seylo/ops";
import { describeUserAgent } from "../components/settings/format";

export const workerUrl = "/sw.js";
export const manifestUrl = "/manifest.webmanifest";

/** What this browser can do, checked at call time (tests stub the globals). */
export interface PushSupport {
  /** A secure context: HTTPS or loopback. */
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notifications: boolean;
  /** Opened as the installed app (home screen, dock), not a browser tab. */
  standalone: boolean;
  /** iPhone or iPad: push only works in the installed app there (iOS 16.4+). */
  ios: boolean;
}

export function pushSupport(): PushSupport {
  const nav = navigator as Navigator & { standalone?: boolean };
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  return {
    secure: window.isSecureContext,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notifications: "Notification" in window,
    standalone: window.matchMedia?.("(display-mode: standalone)").matches === true || nav.standalone === true,
    ios,
  };
}

/** Push works in this browser (an iPhone outside the installed app says no: it has no PushManager there). */
export function canPush(support: PushSupport = pushSupport()): boolean {
  return support.secure && support.serviceWorker && support.pushManager && support.notifications;
}

/** This tab is the panel domain's origin, over HTTPS. */
export function onDomain(domainUrl: string | null, origin = window.location.origin): boolean {
  return domainUrl !== null && origin === domainUrl && window.isSecureContext;
}

/** The name this device gets in the list, from the browser's user agent. */
export function deviceLabel(userAgent = navigator.userAgent): string {
  return describeUserAgent(userAgent) ?? "Browser";
}

const headIds = {
  manifest: "app-manifest",
  capable: "app-capable",
  appleCapable: "app-apple-capable",
  title: "app-title",
  status: "app-status",
};

function upsert(id: string, tag: "link" | "meta", attributes: Record<string, string>): void {
  let element = document.getElementById(id);
  if (!element) {
    element = document.createElement(tag);
    element.id = id;
    document.head.appendChild(element);
  }
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
}

/** Links the manifest and the home screen tags, or takes them out. */
export function applyAppHead(on: boolean, name = document.title): void {
  if (!on) {
    for (const id of Object.values(headIds)) document.getElementById(id)?.remove();
    return;
  }
  upsert(headIds.manifest, "link", { rel: "manifest", href: manifestUrl });
  upsert(headIds.capable, "meta", { name: "mobile-web-app-capable", content: "yes" });
  upsert(headIds.appleCapable, "meta", { name: "apple-mobile-web-app-capable", content: "yes" });
  upsert(headIds.title, "meta", { name: "apple-mobile-web-app-title", content: name });
  upsert(headIds.status, "meta", { name: "apple-mobile-web-app-status-bar-style", content: "default" });
}

/** The service worker's registration, registering it when asked. */
export async function workerRegistration(register: boolean): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing || !register) return existing ?? null;
  return navigator.serviceWorker.register(workerUrl, { scope: "/" });
}

/** This browser's push subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await workerRegistration(false);
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** SHA-256 of the endpoint, hex: how the panel's list names this browser (push.PushDevice.endpointHash). */
export async function endpointHashOf(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const bytes = new Uint8Array(new ArrayBuffer(atob(base64).length));
  atob(base64)
    .split("")
    .forEach((char, i) => {
      bytes[i] = char.charCodeAt(0);
    });
  return bytes;
}

function toBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Whether a subscription was made with this panel's key (a new key needs a new subscription). */
function madeWith(subscription: PushSubscription, publicKey: string): boolean {
  return toBase64Url(subscription.options.applicationServerKey) === publicKey;
}

export class PushDenied extends Error {}

/**
 * Asks for permission (call it from a click) and subscribes this browser
 * with the panel's key; what push.subscribe takes.
 */
export async function subscribeThisBrowser(publicKey: string): Promise<{ endpoint: string; p256dh: string; auth: string; label: string }> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushDenied(permission);
  const registration = await workerRegistration(true);
  if (!registration) throw new Error("This browser has no service workers.");
  await navigator.serviceWorker.ready;
  const old = await registration.pushManager.getSubscription();
  if (old && !madeWith(old, publicKey)) await old.unsubscribe();
  const subscription =
    (old && madeWith(old, publicKey) ? old : null) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) }));
  return {
    endpoint: subscription.endpoint,
    p256dh: toBase64Url(subscription.getKey("p256dh")),
    auth: toBase64Url(subscription.getKey("auth")),
    label: deviceLabel(),
  };
}

/** Drops this browser's subscription (and the worker, when push is off for good). */
export async function unsubscribeThisBrowser(options: { removeWorker?: boolean } = {}): Promise<void> {
  const registration = await workerRegistration(false);
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  await subscription?.unsubscribe();
  if (options.removeWorker) await registration.unregister();
}

/**
 * Brings this tab in line with the panel: the head tags, the worker, and
 * a subscription the panel no longer knows dropped. Returns whether this
 * browser is one of the person's devices.
 */
export async function syncThisBrowser(mine: push.MyPush): Promise<boolean> {
  const here = mine.available && onDomain(mine.domainUrl);
  applyAppHead(here);
  if (!mine.enabled) {
    // Turned off: the panel removed every device, so nothing stays registered on this origin.
    await unsubscribeThisBrowser({ removeWorker: true }).catch(() => {});
    return false;
  }
  // Paused (the domain does not work right now): keep the subscription for when it does.
  if (!mine.available) return false;
  if (!here || !canPush()) return false;
  await workerRegistration(true).catch(() => null);
  const subscription = await currentSubscription();
  if (!subscription) return false;
  const hash = await endpointHashOf(subscription.endpoint);
  const known = mine.devices.some((device) => device.endpointHash === hash);
  if (!known || (mine.publicKey && !madeWith(subscription, mine.publicKey))) {
    await subscription.unsubscribe().catch(() => false);
    return false;
  }
  return true;
}

/** The install prompt Chrome and Edge offer once, kept for an Install button. */
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
let installPrompt: InstallPrompt | null = null;
const installListeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    for (const listener of installListeners) listener();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    for (const listener of installListeners) listener();
  });
}

export function canPromptInstall(): boolean {
  return installPrompt !== null;
}

export function onInstallChange(listener: () => void): () => void {
  installListeners.add(listener);
  return () => installListeners.delete(listener);
}

/** Shows the browser's install dialog; true when the person installed. */
export async function promptInstall(): Promise<boolean> {
  const prompt = installPrompt;
  if (!prompt) return false;
  installPrompt = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  for (const listener of installListeners) listener();
  return outcome === "accepted";
}

/** A tap on a notification while the app is open: the worker asks the page to go there (sw.js). */
export function listenForOpens(navigate: (path: string) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  const handler = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type === "open" && typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//")) navigate(data.url);
  };
  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}
