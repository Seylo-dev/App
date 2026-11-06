import { expect, test } from "bun:test";
import { settings } from "@seylo/ops";
import { brandFileProblem, normalizeHex, presetSwatches } from "./presets";

test("every preset in the contract has a preview", () => {
  expect(Object.keys(presetSwatches).sort()).toEqual([...settings.themePresets].sort());
});

test("normalizeHex accepts 6-digit colors with or without #", () => {
  expect(normalizeHex("#2563eb")).toBe("#2563EB");
  expect(normalizeHex("0f8a6a")).toBe("#0F8A6A");
  expect(normalizeHex("#fff")).toBeNull();
  expect(normalizeHex("blue")).toBeNull();
});

test("brand files must be a known image type and at most 512 KiB", () => {
  expect(brandFileProblem({ type: "image/png", size: 1000 })).toBeNull();
  expect(brandFileProblem({ type: "image/svg+xml", size: 512 * 1024 })).toBeNull();
  expect(brandFileProblem({ type: "image/gif", size: 1000 })).toBe("type");
  expect(brandFileProblem({ type: "image/png", size: 512 * 1024 + 1 })).toBe("size");
});
