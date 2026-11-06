import { describe, expect, test } from "bun:test";
import { isArchive, joinPath, languageFor, parentPath, parseOctal, pathCrumbs } from "./file-kinds";

describe("files popup helpers", () => {
  test("languages by name", () => {
    expect(languageFor("settings.json")).toBe("javascript");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor(".env")).toBe("seylo-env");
    expect(languageFor("nginx.conf")).toBe("ini");
    expect(languageFor("README")).toBe("plaintext");
  });
  test("archives", () => {
    expect(isArchive("backup.tar.gz")).toBe(true);
    expect(isArchive("site.zip")).toBe(true);
    expect(isArchive("notes.txt")).toBe(false);
  });
  test("paths", () => {
    expect(pathCrumbs("images/2026/nov")).toEqual([
      { name: "images", path: "images" },
      { name: "2026", path: "images/2026" },
      { name: "nov", path: "images/2026/nov" },
    ]);
    expect(pathCrumbs("")).toEqual([]);
    expect(joinPath("", "a.txt")).toBe("a.txt");
    expect(joinPath("dir/", "a.txt")).toBe("dir/a.txt");
    expect(parentPath("a/b/c")).toBe("a/b");
    expect(parentPath("a")).toBe("");
  });
  test("octal modes", () => {
    expect(parseOctal("0644")).toBe(0o644);
    expect(parseOctal("755")).toBe(0o755);
    expect(parseOctal("9")).toBeNull();
  });
});
