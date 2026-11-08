import { expect, test } from "bun:test";
import { dismissPlainHttpNotice, plainHttpNoticeDismissed, plainHttpNoticeStorage, plainHttpPage } from "./plain-http";

test("plain HTTP on a network address gets the notice, with the address to tunnel to", () => {
  expect(plainHttpPage({ protocol: "http:", hostname: "203.0.113.5", port: "3000" }, false)).toEqual({ host: "203.0.113.5", port: "3000" });
  expect(plainHttpPage({ protocol: "http:", hostname: "[2001:db8::7]", port: "3000" }, false)).toEqual({
    host: "2001:db8::7",
    port: "3000",
  });
  expect(plainHttpPage({ protocol: "http:", hostname: "panel.example.com", port: "" }, false)).toEqual({
    host: "panel.example.com",
    port: "80",
  });
});

test("HTTPS and loopback (the SSH tunnel) get no notice", () => {
  expect(plainHttpPage({ protocol: "https:", hostname: "panel.example.com", port: "" }, true)).toBeNull();
  expect(plainHttpPage({ protocol: "http:", hostname: "127.0.0.1", port: "3000" }, true)).toBeNull();
  expect(plainHttpPage({ protocol: "http:", hostname: "localhost", port: "5173" }, true)).toBeNull();
});

test("the tailnet URL gets no notice, in HTTPS and in HTTP mode (Tailscale encrypts it)", () => {
  expect(plainHttpPage({ protocol: "https:", hostname: "panel.tail1234.ts.net", port: "" }, true)).toBeNull();
  expect(plainHttpPage({ protocol: "http:", hostname: "panel.tail1234.ts.net", port: "" }, false)).toBeNull();
  expect(plainHttpPage({ protocol: "http:", hostname: "Panel.Tail1234.TS.NET", port: "" }, false)).toBeNull();
  // Only the real suffix: a look-alike domain is an ordinary plain-HTTP page.
  expect(plainHttpPage({ protocol: "http:", hostname: "ts.net.example.com", port: "" }, false)).not.toBeNull();
  expect(plainHttpPage({ protocol: "http:", hostname: "myts.net", port: "" }, false)).not.toBeNull();
});

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

test("dismissing the notice is remembered in this browser's storage", () => {
  const storage = memoryStorage();
  expect(plainHttpNoticeDismissed(storage)).toBe(false);
  dismissPlainHttpNotice(storage);
  expect(storage.items.get(plainHttpNoticeStorage)).toBe("1");
  expect(plainHttpNoticeDismissed(storage)).toBe(true);
});

test("blocked storage never throws: the notice shows, and a dismissal lasts until the next load", () => {
  const blocked = {
    getItem: (): string | null => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  expect(plainHttpNoticeDismissed(blocked)).toBe(false);
  expect(() => dismissPlainHttpNotice(blocked)).not.toThrow();
  expect(plainHttpNoticeDismissed(null)).toBe(false);
  expect(() => dismissPlainHttpNotice(null)).not.toThrow();
  // No window at all (bun test): the default storage is missing, not an error.
  expect(plainHttpNoticeDismissed()).toBe(false);
});
