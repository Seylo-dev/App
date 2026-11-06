import { describe, expect, test } from "bun:test";
import {
  decideWatchFile,
  describeWatchPaths,
  globMatches,
  globToRegExp,
  matchWatchPaths,
  maxChangedPathLength,
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
      expect(globMatches(glob, path)).toBe(matches);
    });
  }
});

/** The first compiler, kept here as the reference: no collapsing, so stacked groups backtrack. */
function referenceRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        i++;
        if (atSegmentStart && glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

describe("matching without backtracking", () => {
  // Small random globs and paths over a few characters, so every corner (runs of stars, "**/" next to "**", "?" next to "/") comes up.
  function random(seed: number) {
    let x = seed;
    return (n: number) => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x % n;
    };
  }
  const globParts = ["a", "b", "/", "*", "**", "**/", "?", ".", "a/", "*/"];
  const pathParts = ["a", "b", "/", ".", "ab", "a/b", "/a", "x"];

  test("the matcher and the collapsed regex agree with the first compiler on random globs and paths", () => {
    const next = random(42);
    let compared = 0;
    for (let g = 0; g < 400; g++) {
      let glob = "";
      for (let k = 0, len = 1 + next(6); k < len; k++) glob += globParts[next(globParts.length)];
      const reference = referenceRegExp(glob);
      for (let p = 0; p < 40; p++) {
        let path = "";
        for (let k = 0, len = next(7); k < len; k++) path += pathParts[next(pathParts.length)];
        const expected = reference.test(path);
        expect({ glob, path, matches: globMatches(glob, path) }).toEqual({ glob, path, matches: expected });
        expect({ glob, path, matches: globToRegExp(glob).test(path) }).toEqual({ glob, path, matches: expected });
        compared++;
      }
    }
    expect(compared).toBe(16_000);
  });

  test("repeated groups collapse in the regex", () => {
    expect(globToRegExp("**/**/**/*.md").source).toBe(String.raw`^(?:.*\/)?[^/]*\.md$`);
    expect(globToRegExp("a/**/**").source).toBe(String.raw`^a\/.*$`);
    expect(globToRegExp("a***b").source).toBe("^a.*b$");
  });

  test("patterns that make a backtracking regex crawl finish in milliseconds on a 400-segment path", () => {
    const deep = `${Array.from({ length: 400 }, () => "a").join("/")}/x.txt`;
    const sameSegment = "a".repeat(4000);
    const patterns = ["**/**/**/**/**/**/*.md", "**/a/**/a/**/a/**/a/**/*.md", "*a*a*a*a*a*b", "a**a**a**a**a**b", "**/*?*?*?*?*.md"];
    const started = performance.now();
    for (const pattern of patterns) {
      expect(globMatches(pattern, deep)).toBe(false);
      expect(globMatches(pattern, sameSegment)).toBe(false);
    }
    expect(matchWatchPaths(patterns, [deep, sameSegment])).toEqual({ deploy: false, reason: "noMatch", checked: 2 });
    expect(performance.now() - started).toBeLessThan(500);
    expect(globMatches("**/**/**/*.txt", deep)).toBe(true);
  });

  test("a changed path past the length cap is not matched: the list counts as incomplete", () => {
    const long = `src/${"a".repeat(maxChangedPathLength)}.md`;
    expect(matchWatchPaths(["src/**"], [long])).toEqual({ deploy: true, reason: "incomplete", checked: 1 });
    expect(matchWatchPaths(["src/**"], [long, "src/a.ts"])).toMatchObject({ deploy: true, reason: "matched", file: "src/a.ts" });
  });
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
