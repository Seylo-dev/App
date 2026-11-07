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
// a small automaton run over the path once with all its live states in a
// bit set, so one match costs a fixed few operations per character and 32
// steps of the glob, whatever the pattern ("a*a*a*..." and
// "**/**/**/*.md" included). A whole push is bounded too: matchWatchPaths
// stops after watchPathsWorkBudget word steps (about 20 ms) and deploys,
// like for an incomplete list. Changed paths longer than
// maxChangedPathLength are not matched at all: they make the list
// incomplete, which deploys.

/** Most patterns a service may have. */
export const maxWatchPaths = 50;
/** Longest pattern. */
export const maxWatchPathLength = 300;
/** Longest changed path that is matched; git allows longer, no real repository has them. */
export const maxChangedPathLength = 4096;
/**
 * Most work one push decision may take, in globCost word steps (one
 * character against 32 steps of a glob; about 2 to 4 ns each). Real pushes
 * stay far below; past it the push deploys and says so.
 */
export const watchPathsWorkBudget = 8_000_000;
/** Work counted per file and per match besides the characters (the fixed part of each call). */
const workPerCall = 8;

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

/** A glob compiled to bit masks over its steps: bit i of a mask is step i (bit n is "the whole glob matched"). */
interface CompiledGlob {
  /** 32-bit words per state set: ceil((steps + 1) / 32). */
  words: number;
  /** The final state's word and bit. */
  finalWord: number;
  finalBit: number;
  /** Per character code that a "char" step names: the steps that read it (with "?" unless it is "/"). */
  reads: Map<number, Int32Array>;
  /** Steps that read any other character except "/": the "?" steps. */
  readsOther: Int32Array;
  /** Steps that read "/" when no "char" step names it: none. */
  readsNothing: Int32Array;
  /** Steps that stay on a character except "/" ("*" and "**"), and on "/" ("**"). */
  stay: Int32Array;
  staySlash: Int32Array;
  /** "**\/" steps: reaching one also enters its run (any characters up to a "/"). */
  dirs: Int32Array;
  /** Steps that may be passed without reading a character ("*", "**", "**\/"). */
  skip: Int32Array;
  /** The longest run of skippable steps in a row ("**\/" then "*": 2): how often a closure shifts. */
  rounds: number;
}

const compiledGlobs = new Map<string, CompiledGlob>();
const slash = 47;

function compileGlob(glob: string): CompiledGlob {
  const hit = compiledGlobs.get(glob);
  if (hit) return hit;
  const steps = globSteps(glob);
  const n = steps.length;
  const words = (n >>> 5) + 1;
  const mask = () => new Int32Array(words);
  const set = (m: Int32Array, i: number) => {
    m[i >>> 5] = (m[i >>> 5] as number) | (1 << (i & 31));
  };
  const one = mask();
  const chars = new Map<number, Int32Array>();
  const stay = mask();
  const staySlash = mask();
  const dirs = mask();
  const skip = mask();
  let rounds = 0;
  let run = 0;
  steps.forEach((step, i) => {
    run = step.kind === "star" || step.kind === "any" || step.kind === "dirs" ? run + 1 : 0;
    rounds = Math.max(rounds, run);
    if (step.kind === "char") {
      const code = step.char.charCodeAt(0);
      let m = chars.get(code);
      if (!m) {
        m = mask();
        chars.set(code, m);
      }
      set(m, i);
    } else if (step.kind === "one") {
      set(one, i);
    } else {
      set(skip, i);
      if (step.kind === "dirs") set(dirs, i);
      else set(stay, i);
      if (step.kind === "any") set(staySlash, i);
    }
  });
  const reads = new Map<number, Int32Array>();
  for (const [code, m] of chars) reads.set(code, code === slash ? m : m.map((w, k) => w | (one[k] as number)));
  const out: CompiledGlob = {
    words,
    finalWord: n >>> 5,
    finalBit: 1 << (n & 31),
    reads,
    readsOther: one,
    readsNothing: mask(),
    stay,
    staySlash,
    dirs,
    skip,
    rounds,
  };
  if (compiledGlobs.size > 2000) compiledGlobs.clear();
  compiledGlobs.set(glob, out);
  return out;
}

/** Bit sets reused by every match (matching is synchronous, so one set is enough); grown for longer globs. */
let scratch = { current: new Int32Array(16), next: new Int32Array(16), inside: new Int32Array(16), carries: new Int32Array(4) };

function scratchFor(words: number, rounds: number) {
  if (scratch.current.length < words || scratch.carries.length < rounds) {
    const size = Math.max(words, scratch.current.length);
    scratch = {
      current: new Int32Array(size),
      next: new Int32Array(size),
      inside: new Int32Array(size),
      carries: new Int32Array(Math.max(rounds, scratch.carries.length)),
    };
  }
  return scratch;
}

/**
 * Whether a glob (without the "!") matches a whole path. Runs the glob's
 * automaton over the path once with every live state in one bit set
 * (bit-parallel, no backtracking): each character costs the same few
 * operations per 32 steps of the glob however many states are live, so
 * a match takes at most globCost(glob, path) word steps.
 */
export function globMatches(glob: string, path: string): boolean {
  const g = compileGlob(glob);
  const { words, rounds, dirs, skip } = g;
  const scratch = scratchFor(words, rounds);
  let current = scratch.current;
  let next = scratch.next;
  // Bit i: inside the run of the "**\/" at step i (any characters; a "/" may end it). Only grows.
  const inside = scratch.inside;
  const carries = scratch.carries;
  current.fill(0, 0, words);
  inside.fill(0, 0, words);
  carries.fill(0, 0, rounds);
  // Start in state 0 and close over it: the same pass as below with nothing read.
  current[0] = 1;
  for (let k = 0; k < words; k++) {
    let v = current[k] as number;
    for (let r = 0; r < rounds; r++) {
      const passed = v & (skip[k] as number);
      v |= (passed << 1) | (carries[r] as number);
      carries[r] = passed >>> 31;
    }
    current[k] = v;
    inside[k] = v & (dirs[k] as number);
  }
  for (let p = 0; p < path.length; p++) {
    const code = path.charCodeAt(p);
    const isSlash = code === slash;
    const reads = g.reads.get(code) ?? (isSlash ? g.readsNothing : g.readsOther);
    const stay = isSlash ? g.staySlash : g.stay;
    let carry = 0;
    let insideCarry = 0;
    let live = 0;
    carries.fill(0, 0, rounds);
    for (let k = 0; k < words; k++) {
      const s = current[k] as number;
      const read = s & (reads[k] as number);
      let v = (read << 1) | carry | (s & (stay[k] as number));
      carry = read >>> 31;
      const d = inside[k] as number;
      if (isSlash) {
        // A "/" may end the run of a "**\/": go on after it.
        v |= (d << 1) | insideCarry;
        insideCarry = d >>> 31;
      }
      // Pass skippable steps: round r of word k needs round r - 1 of word k - 1, which came just before.
      for (let r = 0; r < rounds; r++) {
        const passed = v & (skip[k] as number);
        v |= (passed << 1) | (carries[r] as number);
        carries[r] = passed >>> 31;
      }
      next[k] = v;
      const di = d | (v & (dirs[k] as number));
      inside[k] = di;
      live |= v | di;
    }
    if (live === 0) return false;
    const done = current;
    current = next;
    next = done;
  }
  return ((current[g.finalWord] as number) & g.finalBit) !== 0;
}

/** The most work globMatches does for a glob and a path, in word steps: one per character and 32 steps of the glob. */
export function globCost(glob: string, path: string): number {
  return (path.length + workPerCall) * compileGlob(glob).words;
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
  return decide(patterns, normalizeChangedPath(file), null) as WatchFileDecision;
}

/**
 * The decision for one normalized path, or null when `budget` ran out
 * first. The last matching pattern decides, so patterns are tried from
 * the last one back and the first match ends it.
 */
function decide(patterns: readonly string[], path: string, budget: { left: number } | null): WatchFileDecision | null {
  for (let i = patterns.length - 1; i >= 0; i--) {
    const pattern = patterns[i] as string;
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (body === "") continue;
    if (budget) {
      budget.left -= globCost(body, path);
      if (budget.left < 0) return null;
    }
    if (globMatches(body, path)) return { file: path, included: !negated, pattern };
  }
  const onlyExclusions = patterns.length > 0 && patterns.every((p) => p.startsWith("!"));
  return { file: path, included: onlyExclusions, pattern: null };
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
  /** Matching every file would take more than watchPathsWorkBudget: deploy, as for an incomplete list. */
  | { deploy: true; reason: "tooMany"; checked: number; total: number }
  /** The full list of changed files is known and none counts. */
  | { deploy: false; reason: "noMatch"; checked: number };

/**
 * Decides a push. `files` null means the changed files are not known;
 * `complete` false means the list may be missing files (truncated
 * payloads, capped compare answers). The work is bounded by `budget`
 * (globCost word steps): past it the push deploys.
 */
export function matchWatchPaths(
  patterns: readonly string[],
  files: readonly string[] | null,
  complete = true,
  budget = watchPathsWorkBudget,
): WatchPathsResult {
  if (patterns.length === 0) return { deploy: true, reason: "off" };
  if (files === null) return { deploy: true, reason: "unknown" };
  const left = { left: budget };
  for (let i = 0; i < files.length; i++) {
    const file = files[i] as string;
    // Not matched: the list counts as incomplete, so it never skips a push.
    if (file.length > maxChangedPathLength) {
      complete = false;
      continue;
    }
    left.left -= workPerCall;
    const decision = left.left < 0 ? null : decide(patterns, normalizeChangedPath(file), left);
    if (decision === null) return { deploy: true, reason: "tooMany", checked: i, total: files.length };
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
    case "tooMany":
      return `Watch paths: too many changed files to match (stopped after ${result.checked} of ${result.total}), so this push deploys.`;
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
