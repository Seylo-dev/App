// The panel's service worker, for push notifications only (0.2.7). It
// caches nothing: every page and request goes to the panel as before, so
// a panel update never leaves anyone on an old screen. Registered by
// lib/pwa.ts only while the panel's app and push notifications are on and
// the page is on the panel domain over HTTPS.
//
// A message is the JSON the panel encrypts for this browser
// (apps/panel/src/modules/push/send.ts): { title, body, url, tag }.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Only a path on this panel: a message can never open another site. */
function samePanelPath(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\") ? url : "/";
}

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof message.title === "string" && message.title ? message.title : "Notification";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === "string" ? message.body : "",
      // One notification per alert: a newer one about the same thing replaces it.
      tag: typeof message.tag === "string" ? message.tag : undefined,
      renotify: typeof message.tag === "string",
      icon: "/pwa/icon-192.png",
      badge: "/pwa/badge-96.png",
      timestamp: typeof message.at === "number" ? message.at : Date.now(),
      data: { url: samePanelPath(message.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = samePanelPath(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        // The app moves there without a reload (lib/pwa.ts listens); focus first, as browsers require.
        await open.focus();
        open.postMessage({ type: "open", url: path });
        return;
      }
      await self.clients.openWindow(path);
    })(),
  );
});
