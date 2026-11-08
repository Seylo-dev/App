// Whether this page reached the panel over plain HTTP on a real network
// address (the first-run IP:port), where the setup token, passwords and the
// session cross the network unencrypted. Loopback counts as secure (the
// SSH tunnel the notice suggests), like the browser's isSecureContext. The
// tailnet URL in HTTP mode (a tailnet without HTTPS certificates) is not a
// secure context either, but Tailscale encrypts it end to end, so it does
// not count.

import { slug } from "@seylo/brand";

export interface PlainHttpPage {
  /** The address to tunnel to, without IPv6 brackets. */
  host: string;
  port: string;
}

export function plainHttpPage(location: Pick<Location, "protocol" | "hostname" | "port">, secureContext: boolean): PlainHttpPage | null {
  if (secureContext || location.protocol !== "http:") return null;
  const host = location.hostname.replace(/^\[(.*)\]$/, "$1");
  if (/\.ts\.net\.?$/i.test(host)) return null;
  return { host, port: location.port || "80" };
}

/** The app shell's notice is dismissed per browser (localStorage is per scheme, host and port). */
export const plainHttpNoticeStorage = `${slug}.plainHttpNoticeDismissed`;

type NoticeStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): NoticeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function plainHttpNoticeDismissed(storage: NoticeStorage | null = browserStorage()): boolean {
  try {
    return storage?.getItem(plainHttpNoticeStorage) === "1";
  } catch {
    return false;
  }
}

export function dismissPlainHttpNotice(storage: NoticeStorage | null = browserStorage()): void {
  try {
    storage?.setItem(plainHttpNoticeStorage, "1");
  } catch {
    // Storage blocked (a private window with storage off): the notice goes away until the next page load.
  }
}
