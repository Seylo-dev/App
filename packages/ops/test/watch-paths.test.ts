import { describe, expect, test } from "bun:test";
import {
  decideWatchFile,
  describeWatchPaths,
  globToRegExp,
  matchWatchPaths,
  normalizeWatchPaths,
  normalizeWatchPattern,
  skipMarkerOf,
  watchPatternProblem,
} from "../src";

describe("globToRegExp", () => {
  const cases: [glob: string, path: string, matches: boolean][] = [
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", false],
    ["**/*.md", "README.md", true],
    ["**/*.md", "docs/guide/intro.md", true],
    ["**.md", "docs/guide/intro.md", true],
    ["apps/web/**", "apps/web/src/index.ts", true],
    ["apps/web/**", "apps/web", false],
    ["apps/web/**", "apps/website/index.ts", false],
    ["apps/*/package.json", "apps/api/package.json", true],
    ["apps/*/package.json", "apps/api/sub/package.json", false],
    ["apps/**/package.json", "apps/package.json", true],
    ["apps/**/package.json", "apps/a/b/c/package.json", true],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["src/?.ts", "src//.ts", false],
    ["Dockerfile", "Dockerfile", true],
    ["Dockerfile", "api/Dockerfile", false],
    // Regex characters are literal.
    ["docs/(draft)+.md", "docs/(draft)+.md", true],
    ["docs/(draft)+.md", "docs/draftt.md", false],
    ["a.b", "axb", false],
    ["file[1].txt", "file[1].txt", true],
    ["file[1].txt", "file1.txt", false],
    ["**", "anything/at/all.txt", true],
    ["a/**/b", "a/b", true],
    ["a/**/b", "a/x/y/b", true],
    ["a/**b", "a/x/yb", true],
  ];
  for (const [glob, path, matches] of cases) {
    test(`${glob} ${matches ? "matches" : "does not match"} ${path}`, () => {
      expect(globToRegExp(glob).test(path)).toBe(matches);
    });
  }
});

describe("normalizing patterns", () => {
  test("trims, drops ./ and leading /, and a trailing / means everything below", () => {
    expect(normalizeWatchPattern("  ./apps/web/  ")).toBe("apps/web/**");
    expect(normalizeWatchPattern("/src/*.ts")).toBe("src/*.ts");
    expect(normalizeWatchPattern("! ./docs/")).toBe("!docs/**");
  });

  test("blank lines and repeats are dropped, order kept", () => {
    expect(normalizeWatchPaths(["apps/web/**", "", "  ", "!**/*.md", "apps/web/**", "!"])).toEqual(["apps/web/**", "!**/*.md"]);
  });

  test("problems are explained", () => {
    expect(watchPatternProblem("!")).toBe("The pattern is empty.");
    expect(watchPatternProblem("a\nb")).toBe("Patterns are one line each.");
    expect(watchPatternProblem("x".repeat(301))).toContain("300");
    expect(watchPatternProblem("apps/**")).toBeNull();
  });
});

describe("deciding a push", () => {
  test("no patterns: every push deploys", () => {
    expect(matchWatchPaths([], ["anything"])).toEqual({ deploy: true, reason: "off" });
    expect(matchWatchPaths([], null)).toEqual({ deploy: true, reason: "off" });
  });

  test("a matching file deploys and names the pattern", () => {
    const result = matchWatchPaths(["apps/web/**", "packages/ui/**"], ["README.md", "packages/ui/button.tsx"]);
    expect(result).toEqual({ deploy: true, reason: "matched", file: "packages/ui/button.tsx", pattern: "packages/ui/**" });
    expect(describeWatchPaths(result)).toBe("Watch paths: packages/ui/button.tsx matches packages/ui/**.");
  });

  test("no matching file in a complete list skips", () => {
    const result = matchWatchPaths(["apps/web/**"], ["apps/api/main.go", "README.md"]);
    expect(result).toEqual({ deploy: false, reason: "noMatch", checked: 2 });
    expect(describeWatchPaths(result)).toContain("none of the 2 changed files");
  });

  test("an incomplete or unknown list never skips", () => {
    expect(matchWatchPaths(["apps/web/**"], ["README.md"], false)).toEqual({ deploy: true, reason: "incomplete", checked: 1 });
    expect(matchWatchPaths(["apps/web/**"], null)).toEqual({ deploy: true, reason: "unknown" });
  });

  test("the last matching pattern wins", () => {
    const patterns = ["apps/web/**", "!apps/web/**/*.md", "apps/web/CHANGELOG.md"];
    expect(decideWatchFile(patterns, "apps/web/src/a.ts")).toEqual({ file: "apps/web/src/a.ts", included: true, pattern: "apps/web/**" });
    expect(decideWatchFile(patterns, "apps/web/docs/x.md")).toEqual({
      file: "apps/web/docs/x.md",
      included: false,
      pattern: "!apps/web/**/*.md",
    });
    expect(decideWatchFile(patterns, "apps/web/CHANGELOG.md").included).toBe(true);
    expect(decideWatchFile(patterns, "apps/api/a.ts")).toEqual({ file: "apps/api/a.ts", included: false, pattern: null });
  });

  test("only exclusions: everything they do not exclude counts", () => {
    const patterns = ["!**/*.md", "!docs/**"];
    expect(decideWatchFile(patterns, "src/main.ts")).toEqual({ file: "src/main.ts", included: true, pattern: null });
    expect(decideWatchFile(patterns, "docs/a.png").included).toBe(false);
    expect(matchWatchPaths(patterns, ["README.md", "docs/a.png"])).toEqual({ deploy: false, reason: "noMatch", checked: 2 });
    const kept = matchWatchPaths(patterns, ["README.md", "src/main.ts"]);
    expect(kept).toEqual({ deploy: true, reason: "matched", file: "src/main.ts", pattern: null });
    expect(describeWatchPaths(kept)).toBe("Watch paths: src/main.ts is not excluded by any pattern.");
  });

  test("changed paths with ./ or / prefixes are read like the repository's", () => {
    expect(decideWatchFile(["src/**"], "./src/a.ts").included).toBe(true);
    expect(decideWatchFile(["src/**"], "/src/a.ts").included).toBe(true);
  });
});

describe("skip markers", () => {
  test("[skip ci], [ci skip], [skip cd] and [cd skip] in any case", () => {
    expect(skipMarkerOf("Fix typo [skip ci]")).toBe("[skip ci]");
    expect(skipMarkerOf("docs\n\n[CI SKIP]")).toBe("[ci skip]");
    expect(skipMarkerOf("[Skip CD] bump")).toBe("[skip cd]");
    expect(skipMarkerOf("x [cd skip]")).toBe("[cd skip]");
  });

  test("other text is not a marker", () => {
    expect(skipMarkerOf("skip ci please")).toBeNull();
    expect(skipMarkerOf("[skip-ci]")).toBeNull();
    expect(skipMarkerOf(null)).toBeNull();
    expect(skipMarkerOf("")).toBeNull();
  });
});
