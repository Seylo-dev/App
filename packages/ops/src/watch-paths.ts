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
// So "*.md" is a file in the root only; "**/*.md" is one anywhere. A
// pattern with a "." or ".." path segment ("apps/docs/..", "../x/**")
// never matches, since git names changed files without them, so saving
// refuses it with what to write instead (watchPatternError). A leading
// "./" is dropped, as is a leading "/".
//
// The panel runs this on every push and the web app runs it in the watch
// paths tester, so both always agree. Matching never backtracks: a glob is
// a small automaton run over the path once with all its live states in a
// bit set, so one match costs a fixed few operations per character and 32
// steps of the glob, whatever the pattern ("a*a*a*..." and
// "**/**/**/*.md" included). A path that does not start with the glob's
// literal head or end with its literal tail ("apps/web/" of "apps/web/**",
// ".md" of "**/*.md"), or does not contain the longest literal run in
// between ("__tests__/" of "**/__tests__/**"), is refused before the
// automaton runs, which is most of what real pushes ask. A whole push is
// bounded too: matchWatchPaths stops after watchPathsWorkBudget work units
// (well under a second at worst) and deploys, like for an incomplete
// list. Changed paths longer than maxChangedPathLength are not matched at
// all: they make the list incomplete, which deploys.

/** Most patterns a service may have. */
export const maxWatchPaths = 50;
/** Longest pattern. */
export const maxWatchPathLength = 300;
/** Longest changed path that is matched; git allows longer, no real repository has them. */
export const maxChangedPathLength = 4096;
/**
 * Most work one push decision may take, in globCost units (measured at
 * 0.7 to 2.3 ns each on an Apple M-series core, so a whole budget is about
 * 150 ms at worst). A push of 20,000 files of 200 characters against 50
 * ordinary patterns, nine of them exclusions like "!**\/__tests__/**",
 * uses about 42M; past the budget the push deploys and says so.
 */
export const watchPathsWorkBudget = 64_000_000;
/** Work counted per file and per match besides the characters (the fixed part of each call). */
const workPerCall = 8;
/**
 * Work per character besides the words of the state set: the character's
 * mask lookup and the loop around the words. Without it a one-word glob
 * would cost 10 ns per counted unit instead of 2.
 */
const workPerCharacter = 4;
/** Work counted for a pair refused by its literal head or tail (the automaton never runs). */
const workPerLiteralCheck = 2 * workPerCall;
/**
 * Longest literal run searched for in the middle of a path. String
 * indexOf in Bun 1.4 takes at most about 0.45 ns per character of the
 * path for needles this short (measured up to 32 on 4,096-character paths
 * built to be slow), so half a unit per character searched covers it;
 * past about 250 characters it can take 70 ns per character.
 */
const maxMiddleLength = 32;

/** Trims a pattern and drops a leading "./" or "/" (any run of them); a trailing "/" means everything below. */
export function normalizeWatchPattern(raw: string): string {
  let pattern = raw.trim();
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1).trim();
  pattern = pattern.replace(/^(?:\.?\/)+/, "");
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

/**
 * What is wrong with a pattern: not usable as text, or it never matches
 * because a path segment is "." or ".." ("apps/docs/..", "../x/**",
 * "a/./b"; git names changed files from the repository root without such
 * segments). `instead` is what to write: "apps/docs/**" for
 * "apps/docs/..", "folder/**" when the pattern names no folder before its
 * dots.
 */
type PatternProblem = { kind: "invalid"; text: string } | { kind: "neverMatches"; instead: string };

function patternProblem(pattern: string): PatternProblem | null {
  const negated = pattern.startsWith("!");
  const body = negated ? pattern.slice(1) : pattern;
  if (body === "") return { kind: "invalid", text: "The pattern is empty." };
  if (pattern.length > maxWatchPathLength) return { kind: "invalid", text: `Patterns are at most ${maxWatchPathLength} characters.` };
  if (/[\n\r\t\0]/.test(pattern)) return { kind: "invalid", text: "Patterns are one line each." };
  const segments = body.split("/");
  const dots = segments.findIndex(isDotSegment);
  if (dots < 0) return null;
  // A folder only when nothing but dots and "**" follows it ("apps/docs/..",
  // "apps/docs/../**"): "apps/docs/../web" names no folder to suggest.
  const before = segments.slice(0, dots).filter((s) => s !== "");
  const onlyDotsAfter = segments.slice(dots).every((s) => isDotSegment(s) || s === "**" || s === "");
  const folder = onlyDotsAfter && before.some((s) => s !== "**") ? before.join("/") : "folder";
  return { kind: "neverMatches", instead: `${negated ? "!" : ""}${folder}/**` };
}

const isDotSegment = (segment: string) => segment === "." || segment === "..";

/** The hint after "never matches a file: ". */
function neverMatchesHint(instead: string): string {
  const what = instead.startsWith("!") ? "To exclude a folder" : "To watch a folder";
  return `paths start at the repository root. ${what}, write ${instead}`;
}

/** Why a (normalized) pattern is not usable, or null when it is. */
export function watchPatternProblem(pattern: string): string | null {
  const problem = patternProblem(pattern);
  if (!problem) return null;
  return problem.kind === "invalid" ? problem.text : `It never matches a file: ${neverMatchesHint(problem.instead)}`;
}

/**
 * The message that refuses a (normalized) pattern when watch paths are
 * saved, naming the pattern, or null when it is usable. The panel's
 * services.setWatchPaths and the import plan refuse with it, and the web
 * app's watch paths card shows it as you type, so both say the same.
 */
export function watchPatternError(pattern: string): string | null {
  const problem = patternProblem(pattern);
  if (!problem) return null;
  return problem.kind === "invalid"
    ? `${pattern}: ${problem.text}`
    : `${pattern} never matches a file: ${neverMatchesHint(problem.instead)}`;
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
  /** The literal characters the glob starts with ("apps/web/" of "apps/web/**"): a matching path starts with them. */
  head: string;
  /** The literal characters it ends with after the head (".md" of "**\/*.md"): a matching path ends with them. */
  tail: string;
  /**
   * The longest run of literal characters between head and tail (at most
   * maxMiddleLength of them, "__tests__/" of "**\/__tests__/**"), or "" when
   * none has two: a matching path has it between its head and tail.
   */
  middle: string;
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
  // "char" steps read exactly their character and nothing can be skipped
  // between them, so the first ones read the path's first characters and
  // the last ones its last. The tail stops at the head, so the two never
  // claim the same step.
  const literal = (step: GlobStep) => (step.kind === "char" ? step.char : null);
  let headEnd = 0;
  while (headEnd < n && literal(steps[headEnd] as GlobStep) !== null) headEnd++;
  let tailStart = n;
  while (tailStart > headEnd && literal(steps[tailStart - 1] as GlobStep) !== null) tailStart--;
  const text = (from: number, to: number) =>
    steps
      .slice(from, to)
      .map((step) => literal(step))
      .join("");
  // The same holds for every run of "char" steps in between: a match reads
  // it as one piece somewhere after the head and before the tail.
  let middle = "";
  for (let i = headEnd; i < tailStart; ) {
    if (literal(steps[i] as GlobStep) === null) {
      i++;
      continue;
    }
    let end = i;
    while (end < tailStart && literal(steps[end] as GlobStep) !== null) end++;
    if (end - i > middle.length) middle = text(i, end);
    i = end;
  }
  if (middle.length < 2) middle = "";
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
    head: text(0, headEnd),
    tail: text(tailStart, n),
    middle: middle.slice(0, maxMiddleLength),
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
 * The glob's literal checks on a path: the work they took beyond what
 * runCost counts, as a negative number when they rule the path out (the
 * automaton need not run). Head and tail compare a few characters; the
 * middle is searched for in the path after the head.
 */
function screen(g: CompiledGlob, path: string): number {
  const { head, tail, middle } = g;
  if (path.length < head.length + middle.length + tail.length || !path.startsWith(head) || !path.endsWith(tail))
    return -workPerLiteralCheck;
  if (middle === "") return 0;
  const work = (path.length - head.length + 1) >>> 1;
  const at = path.indexOf(middle, head.length);
  return at >= 0 && at + middle.length <= path.length - tail.length ? work : -(workPerLiteralCheck + work);
}

/**
 * Whether a glob (without the "!") matches a whole path. A path without
 * the glob's literal head, tail and middle is refused at once; otherwise
 * the glob's automaton runs over the path once with every live state in
 * one bit set (bit-parallel, no backtracking): each character costs the
 * same few operations per 32 steps of the glob however many states are
 * live, so a match takes at most globCost(glob, path) units.
 */
export function globMatches(glob: string, path: string): boolean {
  const g = compileGlob(glob);
  return screen(g, path) >= 0 && runGlob(g, path);
}

function runGlob(g: CompiledGlob, path: string): boolean {
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

/**
 * The most work globMatches does for a glob and a path, in units: a small
 * fixed amount when the literal head or tail already rules the path out,
 * half a unit per character searched for the middle, and when the automaton
 * runs, per character one unit per 32 steps of the glob plus the fixed
 * part of reading a character.
 */
export function globCost(glob: string, path: string): number {
  return costOf(compileGlob(glob), path);
}

/** The automaton's work for a path that has the glob's literal head and tail. */
function runCost(g: CompiledGlob, path: string): number {
  return (path.length + workPerCall) * (g.words + workPerCharacter);
}

function costOf(g: CompiledGlob, path: string): number {
  const literals = screen(g, path);
  return literals < 0 ? -literals : literals + runCost(g, path);
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
  return decide(prepare(patterns), normalizeChangedPath(file), null) as WatchFileDecision;
}

/** A list of patterns with each glob compiled once for a whole decision, not looked up again per file. */
interface PreparedPatterns {
  /** In list order; a pattern that is "!" alone is left out. */
  list: { pattern: string; negated: boolean; glob: CompiledGlob }[];
  /** Only "!" patterns: a file none of them matches counts. */
  onlyExclusions: boolean;
}

function prepare(patterns: readonly string[]): PreparedPatterns {
  const list: PreparedPatterns["list"] = [];
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (body !== "") list.push({ pattern, negated, glob: compileGlob(body) });
  }
  return { list, onlyExclusions: patterns.length > 0 && patterns.every((p) => p.startsWith("!")) };
}

/**
 * The decision for one normalized path, or null when `budget` ran out
 * first. The last matching pattern decides, so patterns are tried from
 * the last one back and the first match ends it.
 */
function decide(patterns: PreparedPatterns, path: string, budget: { left: number } | null): WatchFileDecision | null {
  const { list } = patterns;
  for (let i = list.length - 1; i >= 0; i--) {
    const { pattern, negated, glob } = list[i] as PreparedPatterns["list"][number];
    const literals = screen(glob, path);
    if (budget) {
      budget.left -= literals < 0 ? -literals : literals + runCost(glob, path);
      if (budget.left < 0) return null;
    }
    if (literals >= 0 && runGlob(glob, path)) return { file: path, included: !negated, pattern };
  }
  return { file: path, included: patterns.onlyExclusions, pattern: null };
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
 * (globCost units): past it the push deploys.
 */
export function matchWatchPaths(
  patterns: readonly string[],
  files: readonly string[] | null,
  complete = true,
  budget = watchPathsWorkBudget,
): WatchPathsResult {
  if (patterns.length === 0) return { deploy: true, reason: "off" };
  if (files === null) return { deploy: true, reason: "unknown" };
  const prepared = prepare(patterns);
  const left = { left: budget };
  for (let i = 0; i < files.length; i++) {
    const file = files[i] as string;
    // Not matched: the list counts as incomplete, so it never skips a push.
    if (file.length > maxChangedPathLength) {
      complete = false;
      continue;
    }
    left.left -= workPerCall;
    const decision = left.left < 0 ? null : decide(prepared, normalizeChangedPath(file), left);
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
