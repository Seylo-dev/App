import { describe, expect, test } from "bun:test";
import { highlight, parseAnsi, stripAnsi } from "./ansi";

describe("parseAnsi", () => {
  test("plain text is one segment", () => {
    expect(parseAnsi("hello")).toEqual([{ text: "hello" }]);
  });

  test("basic, bright, 256 and true colors, bold and reset", () => {
    const segs = parseAnsi("\x1b[1;31mERR\x1b[0m ok \x1b[92mgreen\x1b[38;5;196mred\x1b[48;2;1;2;3mbg\x1b[m");
    expect(segs).toEqual([
      { text: "ERR", bold: true, fg: "var(--ansi-1)" },
      { text: " ok " },
      { text: "green", fg: "var(--ansi-10)" },
      { text: "red", fg: "rgb(255,0,0)" },
      { text: "bg", fg: "rgb(255,0,0)", bg: "rgb(1,2,3)" },
    ]);
  });

  test("drops cursor moves and OSC titles", () => {
    expect(parseAnsi("\x1b[2K\x1b]0;title\x07done")).toEqual([{ text: "done" }]);
    expect(stripAnsi("\x1b[32mok\x1b[0m\x1b[1A")).toBe("ok");
  });
});

describe("highlight", () => {
  test("marks matches across segment boundaries, case-insensitively", () => {
    const segs = highlight([{ text: "Hello wo", fg: "a" }, { text: "rld world" }], "WORLD");
    expect(segs).toEqual([
      { text: "Hello ", fg: "a" },
      { text: "wo", fg: "a", match: true },
      { text: "rld", match: true },
      { text: " " },
      { text: "world", match: true },
    ]);
  });

  test("no query or no match returns the input", () => {
    const input = [{ text: "abc" }];
    expect(highlight(input, "")).toBe(input);
    expect(highlight(input, "x")).toBe(input);
  });
});
