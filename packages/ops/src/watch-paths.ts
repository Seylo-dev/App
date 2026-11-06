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
// paths tester, so both always agree. Matching never backtracks: a glob is
// a small automaton run over the path once (time grows with the path
// times the pattern, never with combinations of "**"), so a pattern like
// "**/**/**/*.md" cannot stall the panel on a deep path. Changed paths
// longer than maxChangedPathLength are not matched at all: they make the
// list incomplete, which deploys.

/** Most patterns a service may have. */
export const maxWatchPaths = 50;
/** Longest pattern. */
export const maxWatchPathLength = 300;
/** Longest changed path that is matched; git allows longer, no real repository has them. */
export const maxChangedPathLength = 4096;

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

/** One step of a compiled glob. */
type GlobStep =
  | { kind: "char"; char: string }
  /** "?": one character except "/". */
  | { kind: "one" }
  /** "*": any run of characters except "/". */
  | { kind: "star" }
  /** "**" (not a whole segment): any run of characters. */
  | { kind: "any" }
  /** "**\/" at the start of a segment: nothing, or any run that ends in "/". */
  | { kind: "dirs" };

const compiledSteps = new Map<string, GlobStep[]>();

/**
 * The steps of a glob (without the "!"). Repeats collapse: "**\/**\/" is
 * one "**\/", and "**\/" followed by "**" is one "**".
 */
function globSteps(glob: string): GlobStep[] {
  const hit = compiledSteps.get(glob);
  if (hit) return hit;
  const steps: GlobStep[] = [];
  const push = (step: GlobStep) => {
    const last = steps.at(-1);
    if (last?.kind === "dirs" && step.kind === "dirs") return;
    if (last?.kind === "dirs" && step.kind === "any") steps.pop();
    steps.push(step);
  };
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c !== "*") {
      push(c === "?" ? { kind: "one" } : { kind: "char", char: c });
      continue;
    }
    let run = 1;
    while (glob[i + run] === "*") run++;
    const atSegmentStart = i === 0 || glob[i - 1] === "/";
    if (run === 1) {
      push({ kind: "star" });
    } else if (run === 2 && atSegmentStart && glob[i + 2] === "/") {
      // "**/": zero or more folders.
      push({ kind: "dirs" });
      run++;
    } else {
      push({ kind: "any" });
    }
    i += run - 1;
  }
  if (compiledSteps.size > 2000) compiledSteps.clear();
  compiledSteps.set(glob, steps);
  return steps;
}

const compiled = new Map<string, RegExp>();

/**
 * The regular expression for one glob (without the "!"), with repeats
 * collapsed. For showing and testing a pattern: matching uses
 * globMatches, which never backtracks.
 */
export function globToRegExp(glob: string): RegExp {
  const hit = compiled.get(glob);
  if (hit) return hit;
  let out = "";
  for (const step of globSteps(glob)) {
    if (step.kind === "char") out += step.char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    else if (step.kind === "one") out += "[^/]";
    else if (step.kind === "star") out += "[^/]*";
    else if (step.kind === "any") out += ".*";
    else out += "(?:.*/)?";
  }
  const re = new RegExp(`^${out}$`);
  if (compiled.size > 2000) compiled.clear();
  compiled.set(glob, re);
  return re;
}

/**
 * Whether a glob (without the "!") matches a whole path. Runs the glob as
 * a set of positions over the path's characters once: no backtracking.
 */
export function globMatches(glob: string, path: string): boolean {
  const steps = globSteps(glob);
  const n = steps.length;
  // States 0..n: before step i (n: the whole glob matched); n + 1 + i: inside the run of the "**/" at step i.
  const seenAt = new Int32Array(2 * n + 2).fill(-1);
  const stack: number[] = [];
  let current: number[] = [];
  let next: number[] = [];
  let round = 0;
  // Adds a state and every state reachable from it without reading a character.
  const add = (into: number[], state: number) => {
    stack.push(state);
    while (stack.length > 0) {
      const s = stack.pop() as number;
      if (seenAt[s] === round) continue;
      seenAt[s] = round;
      into.push(s);
      if (s >= n) continue;
      const kind = (steps[s] as GlobStep).kind;
      if (kind === "star" || kind === "any") stack.push(s + 1);
      else if (kind === "dirs") stack.push(s + 1, n + 1 + s);
    }
  };
  add(current, 0);
  for (let p = 0; p < path.length; p++) {
    const c = path[p] as string;
    round++;
    next.length = 0;
    for (const s of current) {
      if (s > n) {
        // Inside "**/": any character stays inside, and a "/" may also end the run.
        add(next, s);
        if (c === "/") add(next, s - n);
        continue;
      }
      if (s === n) continue;
      const step = steps[s] as GlobStep;
      if (step.kind === "char") {
        if (c === step.char) add(next, s + 1);
      } else if (step.kind === "one") {
        if (c !== "/") add(next, s + 1);
      } else if (step.kind === "star") {
        if (c !== "/") add(next, s);
      } else if (step.kind === "any") {
        add(next, s);
      }
    }
    if (next.length === 0) return false;
    const done = current;
    current = next;
    next = done;
  }
  return current.includes(n);
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
    if (globMatches(body, path)) {
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
    // Not matched: the list counts as incomplete, so it never skips a push.
    if (file.length > maxChangedPathLength) {
      complete = false;
      continue;
    }
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
