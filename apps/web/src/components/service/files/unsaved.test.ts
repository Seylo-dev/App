import { expect, test } from "bun:test";
import { isUnsaved } from "./files-dialog";

// The Files editor kept "Unsaved changes" after Save: it compared with the file as first loaded.
test("a save counts: unsaved against the last save, else the file as loaded", () => {
  const loaded = "a\n";
  expect(isUnsaved(null, null, loaded)).toBe(false);
  expect(isUnsaved("a\n", null, loaded)).toBe(false);
  expect(isUnsaved("ab\n", null, loaded)).toBe(true);
  // Saved "ab": the same text is saved now, though the read still says "a".
  expect(isUnsaved("ab\n", "ab\n", loaded)).toBe(false);
  // Typed on after the save (or during it): unsaved again.
  expect(isUnsaved("abc\n", "ab\n", loaded)).toBe(true);
  // Back to the loaded text after a save of something else: that is unsaved too.
  expect(isUnsaved("a\n", "ab\n", loaded)).toBe(true);
});
