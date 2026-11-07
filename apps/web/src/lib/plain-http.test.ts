import { expect, test } from "bun:test";
import { plainHttpPage } from "./plain-http";

test("plain HTTP on a network address warns and names the tunnel", () => {
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

test("HTTPS and loopback (the SSH tunnel) do not warn", () => {
  expect(plainHttpPage({ protocol: "https:", hostname: "panel.example.com", port: "" }, true)).toBeNull();
  expect(plainHttpPage({ protocol: "http:", hostname: "127.0.0.1", port: "3000" }, true)).toBeNull();
  expect(plainHttpPage({ protocol: "http:", hostname: "localhost", port: "5173" }, true)).toBeNull();
});
