import { describe, expect, test } from "bun:test";
import {
  decideWatchFile,
  describeWatchPaths,
  globCost,
  globMatches,
  globToRegExp,
  matchWatchPaths,
  maxChangedPathLength,
  maxWatchPathLength,
  maxWatchPaths,
  normalizeWatchPaths,
  normalizeWatchPattern,
  skipMarkerOf,
  watchPatternError,
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
    // The literal head and tail are checked before the automaton runs; they never claim the same character.
    ["a*a", "a", false],
    ["a*a", "aa", true],
    ["ab*ba", "aba", false],
    ["ab*ba", "abba", true],
    ["aa", "aaa", false],
    ["src/**/*.ts", "src/a.tsx", false],
    ["src/**/*.ts", "lib/src/a.ts", false],
    // So is the longest literal run in between, which must lie after the head and before the tail.
    ["**/__tests__/**", "__tests__/a.ts", true],
    ["**/__tests__/**", "src/__tests__/a.ts", true],
    ["**/__tests__/**", "src/__tests__", false],
    ["**/__tests__/**", "src/x__tests__/a.ts", false],
    ["**/*.test.*", "src/a.test.ts", true],
    ["**/*.test.*", "src/a.test", false],
    ["ab*ab*ab", "abab", false],
    ["ab*ab*ab", "ababab", true],
    ["ab*cd*ab", "abcdab", true],
    ["ab*cd*ab", "abcab", false],
    ["ab*cd*ab", "acdab", false],
    ["x*cdcd*y", "xcdcy", false],
    ["x*cdcd*y", "xcdcdy", true],
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

  test("globs whose literal runs sit between stars agree with the first compiler (the middle short cut)", () => {
    const next = random(1234);
    // Common exclusion shapes with no literal head or tail, and runs that repeat or overlap.
    const shapes = ["**/X/**", "!**/X/**", "**/*X*", "**/*X", "*X*", "**X**", "**/*X*/**", "?X?*", "a*X*a", "X*X", "*X*X*", "**/X?/**"];
    const runs = [
      "__tests__",
      ".test.",
      "node_modules",
      "ab",
      "aba",
      "abab",
      "a/b",
      "/a/",
      "é日",
      "\u{1F600}x",
      "a".repeat(40),
      `${"ab".repeat(20)}c`,
    ];
    const noise = ["a", "b", "/", ".", "_", "é", "\u{1F600}"];
    let compared = 0;
    let matched = 0;
    for (let g = 0; g < 600; g++) {
      const run = runs[next(runs.length)] as string;
      const pattern = (shapes[next(shapes.length)] as string).replaceAll("X", run);
      const glob = pattern.replace(/^!/, "");
      const reference = referenceRegExp(glob);
      for (let p = 0; p < 30; p++) {
        // Paths around the run: whole, cut short, cut at either end or with one character changed.
        let path = "";
        for (let k = 0, len = next(6); k < len; k++) {
          const r = next(5);
          if (r === 0) path += run;
          else if (r === 1) path += run.slice(0, next(run.length));
          else if (r === 2) path += run.slice(next(run.length));
          else if (r === 3) {
            const at = next(run.length);
            path += `${run.slice(0, at)}${noise[next(noise.length)]}${run.slice(at + 1)}`;
          } else path += noise[next(noise.length)];
        }
        const expected = reference.test(path);
        if (expected) matched++;
        expect({ glob, path, matches: globMatches(glob, path) }).toEqual({ glob, path, matches: expected });
        // decideWatchFile drops a leading "./" or "/" first, like the repository's own paths.
        const listed = reference.test(path.replace(/^(\.\/)+/, "").replace(/^\/+/, ""));
        expect(decideWatchFile([pattern], path).included).toBe(pattern.startsWith("!") ? !listed : listed);
        compared++;
      }
    }
    expect(compared).toBe(18_000);
    expect(matched).toBeGreaterThan(1000);
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
    expect(performance.now() - started).toBeLessThan(2500);
    expect(globMatches("**/**/**/*.txt", deep)).toBe(true);
  });

  /**
   * A second reference for long globs, where the first compiler's regex
   * backtracks for seconds: the same tokens, decided by a memoized table
   * over (token, position).
   */
  function referenceMatch(glob: string, path: string): boolean {
    const tokens: string[] = [];
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i] as string;
      if (c === "*" && glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        i++;
        if (atSegmentStart && glob[i + 1] === "/") {
          i++;
          tokens.push("dirs");
        } else tokens.push("any");
      } else tokens.push(c === "*" ? "star" : c === "?" ? "one" : `=${c}`);
    }
    const memo = new Map<number, boolean>();
    const at = (t: number, p: number, inDirs: boolean): boolean => {
      const key = (t * (path.length + 1) + p) * 2 + (inDirs ? 1 : 0);
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      let out: boolean;
      if (inDirs) out = p < path.length && ((path[p] === "/" && at(t + 1, p + 1, false)) || at(t, p + 1, true));
      else if (t === tokens.length) out = p === path.length;
      else {
        const token = tokens[t] as string;
        const c = path[p];
        if (token === "star") out = at(t + 1, p, false) || (c !== undefined && c !== "/" && at(t, p + 1, false));
        else if (token === "any") out = at(t + 1, p, false) || (c !== undefined && at(t, p + 1, false));
        else if (token === "dirs") out = at(t + 1, p, false) || at(t, p, true);
        else if (token === "one") out = c !== undefined && c !== "/" && at(t + 1, p + 1, false);
        else out = c === token.slice(1) && at(t + 1, p + 1, false);
      }
      memo.set(key, out);
      return out;
    };
    return at(0, 0, false);
  }

  test("globs longer than 32 steps (several words per state set) agree with a reference", () => {
    const next = random(7);
    const longParts = ["a", "b", "/", "*", "**", "**/", "?", "ab", "a/", "*/", "a*", "?a"];
    let compared = 0;
    let matched = 0;
    for (let g = 0; g < 200; g++) {
      let glob = "";
      while (glob.length < 34 + next(200)) glob += longParts[next(longParts.length)];
      for (let p = 0; p < 30; p++) {
        // Paths built from the glob itself, so that long globs match now and then.
        let path = "";
        for (const c of glob) {
          if (c === "*") path += ["", "a", "ab", "a/b", "/"][next(5)];
          else if (c === "?") path += ["a", "b", "/"][next(3)];
          else path += next(40) === 0 ? "b" : c;
        }
        const expected = referenceMatch(glob, path);
        if (expected) matched++;
        expect({ glob, path, matches: globMatches(glob, path) }).toEqual({ glob, path, matches: expected });
        compared++;
      }
    }
    expect(compared).toBe(6000);
    expect(matched).toBeGreaterThan(50);
    // The reference agrees with the first compiler where that one is quick.
    expect(referenceMatch("a/**/b*?.md", "a/x/y/bcd.md")).toBe(referenceRegExp("a/**/b*?.md").test("a/x/y/bcd.md"));
  });

  test("a glob full of stars costs the same few operations per character: no state-by-state walk", () => {
    // Before: one live state per "*", 149 of them, about 9 ms per match.
    const pattern = "a*".repeat(Math.floor(maxWatchPathLength / 2));
    const path = `${"a".repeat(maxChangedPathLength - 1)}b`;
    globMatches(pattern, path);
    const started = performance.now();
    for (let i = 0; i < 20; i++) expect(globMatches(pattern, path)).toBe(true);
    expect(globMatches(`${pattern}c`, path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(600);
    // 10 words of state, plus the fixed part of reading a character.
    expect(globCost(pattern, path)).toBe((path.length + 8) * (10 + 4));
  });

  test("a whole push is bounded: 50 star patterns against a 5 MiB list of long paths stop at the budget and deploy", () => {
    // Ending in "*" and starting with the paths' letter, so the literal head and tail let every path through to the automaton.
    const patterns = Array.from({ length: maxWatchPaths }, (_, i) => `${"a*".repeat(148)}${String.fromCharCode(99 + (i % 20))}*`);
    const files = Array.from({ length: 1280 }, () => `${"a".repeat(maxChangedPathLength - 1)}b`);
    const started = performance.now();
    const result = matchWatchPaths(patterns, files);
    // Before: about 575 s of blocked event loop. A full budget is about 110 to 150 ms on a current CPU.
    expect(performance.now() - started).toBeLessThan(2500);
    expect(result).toMatchObject({ deploy: true, reason: "tooMany", total: 1280 });
    expect(describeWatchPaths(result)).toContain("too many changed files to match");
  });

  test("the worst glob shape per unit (one word, two skip rounds) on the most files still stops within the budget", () => {
    const patterns = Array.from({ length: maxWatchPaths }, (_, i) => `**/*${"a*".repeat(13)}${String.fromCharCode(99 + (i % 20))}*`);
    const files = Array.from({ length: 20_000 }, () => `${"a".repeat(maxChangedPathLength - 1)}b`);
    const started = performance.now();
    expect(matchWatchPaths(patterns, files)).toMatchObject({ deploy: true, reason: "tooMany", total: 20_000 });
    expect(performance.now() - started).toBeLessThan(2500);
  });

  test("star patterns with a literal tail no path has are refused pair by pair at once and decided in full", () => {
    const patterns = Array.from({ length: maxWatchPaths }, (_, i) => `${"a*".repeat(148)}a*${String.fromCharCode(99 + (i % 20))}`);
    const files = Array.from({ length: 1280 }, () => `${"a".repeat(maxChangedPathLength - 1)}b`);
    const started = performance.now();
    expect(matchWatchPaths(patterns, files)).toEqual({ deploy: false, reason: "noMatch", checked: 1280 });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(globCost(patterns[0] as string, files[0] as string)).toBe(16);
  });

  test("patterns refused by their middle literal are charged for the search, so the slowest searches still stop within the budget", () => {
    // 32-character middles that are all "a" but one "b", no literal head or tail: every pair searches a whole 4,096-character path.
    const patterns = Array.from({ length: maxWatchPaths }, (_, i) => `*${"a".repeat(i % 32)}b${"a".repeat(31 - (i % 32))}*`);
    const path = "a".repeat(maxChangedPathLength);
    const files = Array.from({ length: 20_000 }, () => path);
    const started = performance.now();
    expect(matchWatchPaths(patterns, files)).toMatchObject({ deploy: true, reason: "tooMany", total: 20_000 });
    expect(performance.now() - started).toBeLessThan(2500);
    // Half a unit per character searched after the head, and the fixed part of a refused pair.
    expect(globCost(patterns[0] as string, path)).toBe(16 + maxChangedPathLength / 2);
    // Only the first 32 characters of a longer run are searched for (43 steps: 2 words of state).
    expect(globCost(`*${"a".repeat(40)}b*`, path)).toBe((path.length + 8) * (2 + 4) + maxChangedPathLength / 2);
  });

  test("ordinary large pushes are decided in full: 50 realistic patterns against 5,000 and 20,000 changed files", () => {
    // Before: the budget ran out after 3,581 of 5,000 short paths (and 758 of 20,000 long ones), so the push deployed unfiltered.
    const patterns = [
      "apps/web/**",
      "apps/api/**",
      "packages/ui/src/**/*.tsx",
      "!**/*.md",
      "!**/*.test.ts",
      "docs/**",
      "infra/terraform/**/*.tf",
      "services/*/Dockerfile",
      "**/package.json",
      "!**/__snapshots__/**",
    ];
    while (patterns.length < maxWatchPaths) patterns.push(`libs/lib${patterns.length}/src/**/*.ts`);
    const short = Array.from({ length: 5_000 }, (_, i) => `tools/gen/out/dir${i % 37}/sub${i % 11}/file-${i}.go`);
    const long = Array.from({ length: 20_000 }, (_, i) => `${"segment/".repeat(24)}file-${i}.ts`);
    expect(short.every((f) => f.length >= 30 && f.length <= 45)).toBe(true);
    expect(matchWatchPaths(patterns, short)).toEqual({ deploy: false, reason: "noMatch", checked: 5_000 });
    expect(matchWatchPaths(patterns, long)).toEqual({ deploy: false, reason: "noMatch", checked: 20_000 });
    // Exclusions with no literal head or tail are refused by the literal run in their middle. Before: tooMany after 17,022.
    const monorepo = [...patterns.slice(0, 9)];
    monorepo.push("!**/__tests__/**", "!**/node_modules/**", "!**/fixtures/**", "!**/*.test.*", "!**/*.spec.*", "!**/testdata/**");
    monorepo.push("!**/.storybook/**", "!**/*.stories.*", "!**/__snapshots__/**");
    while (monorepo.length < maxWatchPaths) monorepo.push(`libs/lib${monorepo.length}/src/**/*.ts`);
    const medium = Array.from(
      { length: 20_000 },
      (_, i) => `packages/service-${i % 40}/src/modules/feature-${i % 97}/components/widget-${i}.tsx`,
    );
    expect(medium.reduce((sum, f) => sum + f.length, 0) / medium.length).toBeGreaterThan(65);
    expect(matchWatchPaths(monorepo, medium)).toEqual({ deploy: false, reason: "noMatch", checked: 20_000 });
    // The exclusions still decide: a test file under apps/web is excluded, any other file there counts.
    const excluded = [...medium.slice(0, 19_999), "apps/web/src/__tests__/a.ts"];
    expect(matchWatchPaths(monorepo, excluded)).toEqual({ deploy: false, reason: "noMatch", checked: 20_000 });
    const counted = [...medium.slice(0, 19_999), "apps/web/src/a.ts"];
    expect(matchWatchPaths(monorepo, counted)).toMatchObject({ reason: "matched", pattern: "apps/web/**" });
    // One file that counts still deploys, wherever it is in the list.
    expect(matchWatchPaths(patterns, [...long.slice(0, 19_999), "apps/web/src/index.ts"])).toEqual({
      deploy: true,
      reason: "matched",
      file: "apps/web/src/index.ts",
      pattern: "apps/web/**",
    });
  });

  test("the budget counts every pattern tried; a list that fits is decided in full", () => {
    const patterns = ["src/**", "!src/**/*.md"];
    const files = ["docs/a.md", "docs/b.md", "lib/x.md"];
    const cost = (file: string) => 8 + patterns.reduce((sum, p) => sum + globCost(p.replace(/^!/, ""), file), 0);
    const all = files.reduce((sum, f) => sum + cost(f), 0);
    expect(matchWatchPaths(patterns, files, true, all)).toEqual({ deploy: false, reason: "noMatch", checked: 3 });
    expect(matchWatchPaths(patterns, files, true, all - 1)).toEqual({ deploy: true, reason: "tooMany", checked: 2, total: 3 });
  });

  test("the last pattern is tried first and a match there ends the file", () => {
    // "src/**" is never run for a file the last pattern decides: the budget covers only that one.
    const file = "src/a.ts";
    const last = 8 + globCost("src/*.ts", file);
    expect(matchWatchPaths(["src/**", "!src/*.ts"], [file], true, last)).toEqual({ deploy: false, reason: "noMatch", checked: 1 });
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
    expect(watchPatternError("a\nb")).toBe("a\nb: Patterns are one line each.");
    expect(watchPatternError("apps/**")).toBeNull();
  });

  test('any run of leading "./" and "/" is dropped, so it is never refused', () => {
    expect(normalizeWatchPattern("/./src/**")).toBe("src/**");
    expect(normalizeWatchPattern(".//./src/")).toBe("src/**");
    expect(normalizeWatchPattern("!/./docs/**")).toBe("!docs/**");
    // Not a leading "./": kept, and refused below.
    expect(normalizeWatchPattern("../x/**")).toBe("../x/**");
    expect(normalizeWatchPattern(".github/workflows/*.yml")).toBe(".github/workflows/*.yml");
  });
});

describe('patterns with a "." or ".." segment never match and are refused', () => {
  const hint = "paths start at the repository root. To watch a folder, write";
  test("the message names the pattern and the folder pattern to write instead", () => {
    expect(watchPatternError("apps/docs/..")).toBe(`apps/docs/.. never matches a file: ${hint} apps/docs/**`);
    expect(watchPatternError("apps/docs/.")).toBe(`apps/docs/. never matches a file: ${hint} apps/docs/**`);
    expect(watchPatternError(normalizeWatchPattern("apps/docs/../"))).toBe(`apps/docs/../** never matches a file: ${hint} apps/docs/**`);
    expect(watchPatternError("apps/*/../**")).toBe(`apps/*/../** never matches a file: ${hint} apps/*/**`);
    expect(watchPatternProblem("apps/docs/..")).toBe(`It never matches a file: ${hint} apps/docs/**`);
  });

  test('without a folder before the dots, or with more after them, the hint is "folder/**"', () => {
    expect(watchPatternError("../x/**")).toBe(`../x/** never matches a file: ${hint} folder/**`);
    expect(watchPatternError("a/./b")).toBe(`a/./b never matches a file: ${hint} folder/**`);
    expect(watchPatternError("apps/docs/../web")).toBe(`apps/docs/../web never matches a file: ${hint} folder/**`);
    expect(watchPatternError("**/..")).toBe(`**/.. never matches a file: ${hint} folder/**`);
    expect(watchPatternError("..")).toBe(`.. never matches a file: ${hint} folder/**`);
    expect(watchPatternError(".")).toBe(`. never matches a file: ${hint} folder/**`);
  });

  test("an exclusion keeps its !", () => {
    expect(watchPatternError("!apps/docs/..")).toBe(
      "!apps/docs/.. never matches a file: paths start at the repository root. To exclude a folder, write !apps/docs/**",
    );
  });

  test("no file git names matches them, which is why they are refused", () => {
    for (const glob of ["apps/docs/..", "apps/docs/.", "../x/**", "a/./b"]) {
      for (const path of ["apps/docs/intro.md", "apps/docs", "apps", "x/a.ts", "a/b", "a/b/c.ts", "./x/a.ts"]) {
        expect(matchWatchPaths([glob], [path])).toEqual({ deploy: false, reason: "noMatch", checked: 1 });
      }
    }
  });

  test("ordinary patterns, dots inside names and a leading ./ pass", () => {
    const ok = [
      "**/*.md",
      "!docs/**",
      ".github/workflows/*.yml",
      "apps/web/**",
      "*.config.ts",
      "src/.env.example",
      "apps/docs/...",
      "a..b/**",
      "**/.well-known/**",
      "?",
    ];
    for (const pattern of ok) expect(watchPatternError(pattern)).toBeNull();
    expect(normalizeWatchPaths(["./src/**", "!./docs/"])).toEqual(["src/**", "!docs/**"]);
    for (const pattern of normalizeWatchPaths(["./src/**", "!./docs/"])) expect(watchPatternError(pattern)).toBeNull();
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
