import { expect, test } from "bun:test";
import { cn } from "./utils";

test("a later shadow replaces the theme's own shadows", () => {
  // The terminal switch's pill: shadow-segment drew a 1px ring in the dark presets next to shadow-none.
  expect(cn("rounded-chip bg-card shadow-segment", "bg-terminal-field shadow-none")).toBe("rounded-chip bg-terminal-field shadow-none");
  for (const token of ["card", "control", "primary", "segment", "popover", "sidebar", "button"]) {
    expect(cn(`shadow-${token}`, "shadow-none")).toBe("shadow-none");
    expect(cn("shadow-none", `shadow-${token}`)).toBe(`shadow-${token}`);
  }
  // Variants and shadow colors stay apart.
  expect(cn("shadow-card hover:shadow-popover", "shadow-none")).toBe("hover:shadow-popover shadow-none");
  expect(cn("shadow-card", "shadow-black/10")).toBe("shadow-card shadow-black/10");
});
