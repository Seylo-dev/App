// Watch paths: which changed files make a push deploy a service. A service
// keeps an ordered list of glob patterns; a pattern that starts with "!"
// excludes. For each changed file the last pattern that matches decides
// (like Coolify); with only "!" patterns, every file they do not exclude
// counts. A push deploys when at least one changed file counts. An empty
// list turns the filter off.
//
// Globs are anchored at the repository root:
//   *    any characters except "/"
//   **   any characters including "/"; "**/" also matches no folder at all
//   ?    one character except "/"
//   dir/ the same as dir/**
// So "*.md" is a file in the root only; "**/*.md" is one anywhere.
//
// The panel runs this on every push and the web app runs it in the watch
// paths tester, so both always agree.

/** Most patterns a service may have. */
export const maxWatchPaths = 50;
/** Longest pattern. */
export const maxWatchPathLength = 300;

/** Trims a pattern and drops a leading "./" or "/"; a trailing "/" means everything below. */
export function normalizeWatchPattern(raw: string): string {
  let pattern = raw.trim();
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1).trim();
  pattern = pattern.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (pattern.endsWith("/")) pattern = `${pattern}**`;
  return negated ? `!${pattern}` : pattern;
}

/** Normalizes a list for storage: one pattern per entry, blank ones and exact repeats dropped. */
export function normalizeWatchPaths(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of raw) {
    const pattern = normalizeWatchPattern(line);
    if (pattern === "" || pattern === "!") continue;
    if (!out.includes(pattern)) out.push(pattern);
  }
  return out;
}

/** Why a pattern is not usable, or null when it is. */
export function watchPatternProblem(pattern: string): string | null {
  const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  if (body === "") return "The pattern is empty.";
  if (pattern.length > maxWatchPathLength) return `Patterns are at most ${maxWatchPathLength} characters.`;
  if (/[\n\r\t\0]/.test(pattern)) return "Patterns are one line each.";
  return null;
}

const compiled = new Map<string, RegExp>();

/** The regular expression for one glob (without the "!"). */
export function globToRegExp(glob: string): RegExp {
  const hit = compiled.get(glob);
  if (hit) return hit;
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        i++;
        if (atSegmentStart && glob[i + 1] === "/") {
          // "**/": zero or more folders.
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
  const re = new RegExp(`^${out}$`);
  if (compiled.size > 2000) compiled.clear();
  compiled.set(glob, re);
  return re;
}

/** A changed file as the repository names it, without a leading "./" or "/". */
export function normalizeChangedPath(path: string): string {
  return path.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

export interface WatchFileDecision {
  file: string;
  /** Whether this file makes the push deploy. */
  included: boolean;
  /** The pattern that decided, or null when none matched (only "!" patterns: included by default). */
  pattern: string | null;
}

/** What the patterns say about one changed file. */
export function decideWatchFile(patterns: readonly string[], file: string): WatchFileDecision {
  const path = normalizeChangedPath(file);
  const onlyExclusions = patterns.length > 0 && patterns.every((p) => p.startsWith("!"));
  let included = onlyExclusions;
  let decidedBy: string | null = null;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (body === "") continue;
    if (globToRegExp(body).test(path)) {
      included = !negated;
      decidedBy = pattern;
    }
  }
  return { file: path, included, pattern: decidedBy };
}

export type WatchPathsResult =
  /** The service has no watch paths: every push deploys. */
  | { deploy: true; reason: "off" }
  /** A changed file counts. */
  | { deploy: true; reason: "matched"; file: string; pattern: string | null }
  /** Nothing in `files` counts, but the list is not the whole push: deploy anyway, never skip silently. */
  | { deploy: true; reason: "incomplete"; checked: number }
  /** The changed files are not known at all. */
  | { deploy: true; reason: "unknown" }
  /** The full list of changed files is known and none counts. */
  | { deploy: false; reason: "noMatch"; checked: number };

/**
 * Decides a push. `files` null means the changed files are not known;
 * `complete` false means the list may be missing files (truncated
 * payloads, capped compare answers).
 */
export function matchWatchPaths(patterns: readonly string[], files: readonly string[] | null, complete = true): WatchPathsResult {
  if (patterns.length === 0) return { deploy: true, reason: "off" };
  if (files === null) return { deploy: true, reason: "unknown" };
  for (const file of files) {
    const decision = decideWatchFile(patterns, file);
    if (decision.included) return { deploy: true, reason: "matched", file: decision.file, pattern: decision.pattern };
  }
  if (!complete) return { deploy: true, reason: "incomplete", checked: files.length };
  return { deploy: false, reason: "noMatch", checked: files.length };
}

/** One line for the deploy log or the webhook delivery log. */
export function describeWatchPaths(result: WatchPathsResult): string {
  switch (result.reason) {
    case "off":
      return "No watch paths: every push deploys.";
    case "matched":
      return result.pattern
        ? `Watch paths: ${result.file} matches ${result.pattern}.`
        : `Watch paths: ${result.file} is not excluded by any pattern.`;
    case "incomplete":
      return `Watch paths: none of the ${result.checked} changed files listed matches, but the list is incomplete, so this push deploys.`;
    case "unknown":
      return "Watch paths: the changed files are not known, so this push deploys.";
    case "noMatch":
      return result.checked === 1
        ? "Skipped by watch paths: the one changed file matches no pattern."
        : `Skipped by watch paths: none of the ${result.checked} changed files matches.`;
  }
}

const skipMarker = /\[(skip ci|ci skip|skip cd|cd skip)\]/i;

/** The "[skip ci]"-style marker in a commit message or PR title, or null. */
export function skipMarkerOf(message: string | null | undefined): string | null {
  if (!message) return null;
  const found = skipMarker.exec(message);
  return found ? `[${(found[1] as string).toLowerCase()}]` : null;
}
