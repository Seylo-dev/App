// Keeps this tab in line with the installable app and push notifications
// (lib/pwa.ts): on, and on the panel domain, the manifest is linked and the
// service worker registered; turned off, both go (paused while the domain
// does not work, they stay). A tap on a notification while the app is open
// moves it to the alert's page without a reload.

import { push, system } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { listenForOpens, syncThisBrowser, workerRegistration } from "../lib/pwa";

export function AppPushSync() {
  const navigate = useNavigate();
  const features = useOp(system.features, {});
  // A worker on this origin means push was on here once: ask the panel, even while it is paused or off.
  const [hasWorker, setHasWorker] = useState(false);
  useEffect(() => {
    void workerRegistration(false)
      .then((registration) => setHasWorker(registration !== null))
      .catch(() => {});
  }, []);
  const mine = useOp(push.mine, {}, { enabled: features.data?.appPush?.enabled === true || hasWorker });

  useEffect(() => listenForOpens((path) => void navigate({ to: path })), [navigate]);
  useEffect(() => {
    if (mine.data) void syncThisBrowser(mine.data).catch(() => {});
  }, [mine.data]);

  return null;
}
