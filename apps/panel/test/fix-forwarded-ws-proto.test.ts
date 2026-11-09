// Traefik sends X-Forwarded-Proto "wss" (and "ws") for WebSocket upgrades.
// requestOrigin took only "https" and "http", so every agent that connected
// through the panel domain was recorded as dialing plain http://<domain>:
// closing IP access was refused ("e2e-b and e2e-c connect over plain
// http://") and removing the domain did not ask first (e2e checks 39, 31).

import { describe, expect, test } from "bun:test";
import { forwardedScheme, requestOrigin } from "../src/http/request-origin";

const upgrade = (proto: string) =>
  new Request("http://seylo-panel00000000000-1:3000/api/agent/connect", {
    headers: { host: "panel.example.com", "x-forwarded-proto": proto, upgrade: "websocket" },
  });

describe("X-Forwarded-Proto of a WebSocket upgrade", () => {
  test("wss through a trusted proxy is https, ws is http", () => {
    expect(requestOrigin(upgrade("wss"), true)).toBe("https://panel.example.com");
    expect(requestOrigin(upgrade("ws"), true)).toBe("http://panel.example.com");
    expect(requestOrigin(upgrade("https"), true)).toBe("https://panel.example.com");
  });

  test("an untrusted client's header still counts for nothing", () => {
    expect(requestOrigin(upgrade("wss"), false)).toBe("http://panel.example.com");
  });

  test("forwardedScheme reads the first value, any case, and refuses the rest", () => {
    expect(forwardedScheme("WSS, http")).toBe("https");
    expect(forwardedScheme(" ws ")).toBe("http");
    expect(forwardedScheme("gopher")).toBeNull();
    expect(forwardedScheme(null)).toBeNull();
  });
});
