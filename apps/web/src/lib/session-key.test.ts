import { afterEach, beforeEach, expect, test } from "bun:test";
import { sessionKeyHeader, sessionKeyStorage } from "@seylo/ops";
import { readSessionKey, sessionFetch, sessionKeyHeaders } from "./session-key";

const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;
let stored: Map<string, string>;
let sent: Headers[];
let answer: Record<string, string>;

beforeEach(() => {
  stored = new Map();
  sent = [];
  answer = {};
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    },
  };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response("{}", { headers: answer });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

test("the key a sign-in hands out is kept and sent with every later call", async () => {
  await sessionFetch("/api/v1/auth.whoami");
  expect(sent[0]?.has(sessionKeyHeader)).toBe(false);

  answer = { [sessionKeyHeader]: "k1" };
  await sessionFetch("/api/v1/auth.login", { method: "POST", headers: { "content-type": "application/json" } });
  expect(stored.get(sessionKeyStorage)).toBe("k1");

  answer = {};
  await sessionFetch("/api/v1/projects.list");
  expect(sent[2]?.get(sessionKeyHeader)).toBe("k1");
  expect(sessionKeyHeaders()).toEqual({ [sessionKeyHeader]: "k1" });
});

test("an empty key from the panel (sign-out) forgets it", async () => {
  stored.set(sessionKeyStorage, "k1");
  answer = { [sessionKeyHeader]: "" };
  await sessionFetch("/api/v1/auth.logout", { method: "POST" });
  expect(readSessionKey()).toBeNull();
  expect(sessionKeyHeaders()).toEqual({});
});
