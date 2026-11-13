// The browser half of the session. The panel's session cookie is useless
// without a key it hands out in a response header on sign-in; the app keeps
// that key in this origin's localStorage and sends it back on every call.
// Cookies have no port, so on a plain-HTTP IP:port panel every other port
// of the address gets the cookie too, but localStorage is per scheme, host
// and port: only this panel's own pages can read the key.

import { sessionKeyHeader, sessionKeyStorage } from "@seylo/ops";
import { serverClock } from "./server-clock";

export function readSessionKey(): string | null {
  try {
    return window.localStorage.getItem(sessionKeyStorage);
  } catch {
    return null;
  }
}

function writeSessionKey(key: string | null): void {
  try {
    if (key) window.localStorage.setItem(sessionKeyStorage, key);
    else window.localStorage.removeItem(sessionKeyStorage);
  } catch {
    // Storage blocked (a private window with storage off): calls go out without a key and the panel asks to sign in.
  }
}

/** Keeps the key a response hands out (a new session) and forgets it when the panel clears it (sign-out). */
export function rememberSessionKey(headers: { get(name: string): string | null }): void {
  const key = headers.get(sessionKeyHeader);
  if (key !== null) writeSessionKey(key || null);
}

/** Request headers with the session key, for calls that do not go through the op client (uploads). */
export function sessionKeyHeaders(): Record<string, string> {
  const key = readSessionKey();
  return key ? { [sessionKeyHeader]: key } : {};
}

/** fetch for the op client: adds the key to every call and keeps a new one; its Date header sets the panel's clock. */
export async function sessionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(sessionKeyHeaders())) headers.set(name, value);
  const sentAt = Date.now();
  const response = await fetch(input, { ...init, headers });
  serverClock.observe(response.headers.get("date"), sentAt, Date.now());
  rememberSessionKey(response.headers);
  return response;
}
