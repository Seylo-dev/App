import { expect, test } from "bun:test";
import { t } from "./t";

test("looks up nested keys", () => {
  expect(t("nav.dashboard")).toBe("Dashboard");
});

test("fills placeholders and picks plural forms", () => {
  expect(t("sidebar.nodesOnline", { count: 1 })).toBe("1 node online");
  expect(t("sidebar.nodesOnline", { count: 3 })).toBe("3 nodes online");
  expect(t("auth.title", { name: "Panel" })).toBe("Sign in to Panel");
});

test("leaves unknown placeholders visible instead of dropping them", () => {
  expect(t("auth.title")).toBe("Sign in to {name}");
});
