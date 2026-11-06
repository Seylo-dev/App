// The first paint's accent CSS (panel) and the web app's rewrite must be the
// same string, or the selected nav item flashes the preset's color first.

import { expect, test } from "bun:test";
import { accentCss as webAccentCss } from "../../web/src/lib/accent";
import { accentCss } from "../src/modules/settings/boot";

test("panel and web app build the same accent CSS", () => {
  for (const accent of ["#0F8A6A", "#2563eb", null, "red", "#12345"]) expect(accentCss(accent)).toBe(webAccentCss(accent));
  expect(accentCss("#0F8A6A")).toContain("--accent:color-mix(in oklab,#0F8A6A 13%,var(--card))");
});
