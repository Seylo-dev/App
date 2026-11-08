import { describe, expect, test } from "bun:test";
import { safeRedirectPath } from "./redirect";

const origin = "https://panel.example.com";

describe("safeRedirectPath", () => {
  test("keeps paths on this panel", () => {
    expect(safeRedirectPath("/settings/security", origin)).toBe("/settings/security");
    expect(safeRedirectPath("/oauth/authorize?client_id=x&state=y", origin)).toBe("/oauth/authorize?client_id=x&state=y");
    expect(safeRedirectPath("/cli/approve#top", origin)).toBe("/cli/approve#top");
  });

  test("refuses anything that leaves the panel", () => {
    for (const value of [
      "https://evil.example/",
      "//evil.example/x",
      "/\\evil.example/x",
      "/\\/evil.example",
      "/..//evil.example",
      "/a/..//evil.example",
      "/%2e%2e//evil.example",
      "/x/../..//evil.example",
      "/.//evil.example",
      "javascript:alert(1)",
      "settings",
      "",
      42,
      undefined,
    ]) {
      expect(safeRedirectPath(value, origin)).toBeUndefined();
    }
  });

  test("keeps dot-segment paths that stay on the panel", () => {
    expect(safeRedirectPath("/a/../settings", origin)).toBe("/settings");
    expect(safeRedirectPath("/a/..//b/x", origin)).toBeUndefined();
  });
});
