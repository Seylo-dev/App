// ${{target.VARIABLE}} references. target is a service name in the same
// project or "project" for the project's shared variables. Whitespace
// inside the braces is allowed: ${{ db.URL }}. A list variable takes an
// index right after its name, 0-based: ${{api.DOMAINS[1]}} (a whole
// number, nothing else inside the brackets; which variables are lists is
// the analyzer's business, analyze.ts).

import { type LineIndex, rangeContains } from "./source";
import type { Diagnostic, EnvEntry, EnvReference, ParsedEnv } from "./types";

/** Reference prefix of the project's shared variables. */
export const sharedTarget = "project";

const open = "${{";
const close = "}}";
/** target.VARIABLE and the rest of the braces (blanks, an index, or something wrong), split without backtracking. */
const inner = /^(\s*)([A-Za-z0-9_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/;
/** A rest that is meant as an index, well-formed or not: brackets (an unclosed one, one after a blank too) and nothing after. */
const bracketShape = /^\s*\[[^\]]*\]?$/;
/** A well-formed index: digits only. */
const indexPattern = /^\[(\d+)\]$/;

/** Same grammar as the parser, for substituting references in unescaped values. */
const referencePattern = /\$\{\{\s*([A-Za-z0-9_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?\s*\}\}/g;

/**
 * Finds references in text[from, to). A reference never spans lines.
 * Returns the references and syntax problems for broken ones.
 */
export function scanReferences(index: LineIndex, from: number, to: number): { references: EnvReference[]; problems: Diagnostic[] } {
  const text = index.text;
  const references: EnvReference[] = [];
  const problems: Diagnostic[] = [];
  let at = text.indexOf(open, from);
  while (at !== -1 && at < to) {
    const lineEnd = endOfLine(text, at, to);
    const closeAt = text.indexOf(close, at + open.length);
    if (closeAt === -1 || closeAt + close.length > lineEnd) {
      problems.push(syntax(index, "unterminated-reference", at, lineEnd, "Reference is missing its closing }}"));
      at = text.indexOf(open, lineEnd);
      continue;
    }
    const end = closeAt + close.length;
    const body = text.slice(at + open.length, closeAt);
    const match = inner.exec(body);
    const rest = match?.[4]?.trimEnd() ?? "";
    if (!match || (rest !== "" && !bracketShape.test(rest))) {
      problems.push(
        syntax(
          index,
          "malformed-reference",
          at,
          end,
          "A reference looks like ${{service.VARIABLE}}",
          "Use a service name or project, a dot, then a variable name.",
        ),
      );
    } else {
      const leading = match[1] ?? "";
      const target = match[2] ?? "";
      const variable = match[3] ?? "";
      const bracket = rest === "" ? undefined : rest;
      const targetStart = at + open.length + leading.length;
      const variableStart = targetStart + target.length + 1;
      const indexStart = variableStart + variable.length;
      const digits = bracket === undefined ? undefined : indexPattern.exec(bracket)?.[1];
      if (bracket !== undefined && digits === undefined) {
        problems.push(malformedIndex(index, variable, bracket, indexStart));
      } else {
        references.push({
          raw: text.slice(at, end),
          target,
          variable,
          range: index.range(at, end),
          targetRange: index.range(targetStart, targetStart + target.length),
          variableRange: index.range(variableStart, variableStart + variable.length),
          ...(bracket !== undefined && digits !== undefined
            ? { index: Number(digits), indexRange: index.range(indexStart, indexStart + bracket.length) }
            : {}),
        });
      }
    }
    at = text.indexOf(open, end);
  }
  return { references, problems };
}

function endOfLine(text: string, from: number, limit: number): number {
  const newline = text.indexOf("\n", from);
  return newline === -1 ? limit : Math.min(newline, limit);
}

function syntax(index: LineIndex, code: Diagnostic["code"], start: number, end: number, message: string, detail = ""): Diagnostic {
  return { code, severity: "error", message, detail, params: {}, range: index.range(start, end), fixes: [] };
}

/**
 * VARIABLE[...] with no whole number in its brackets (DOMAINS[],
 * DOMAINS[-1], DOMAINS[ 1 ], DOMAINS[x], DOMAINS [1], an unclosed
 * DOMAINS[1): a malformed-reference on the brackets, params variable,
 * index (what is inside them) and written (the brackets as written).
 */
function malformedIndex(index: LineIndex, variable: string, bracket: string, start: number): Diagnostic {
  const from = bracket.indexOf("[") + 1;
  const inside = bracket.slice(from, bracket.endsWith("]") ? -1 : undefined);
  return {
    code: "malformed-reference",
    severity: "error",
    message: `The index in ${variable}${bracket} must be a whole number`,
    detail: `Write it in [ ] right after the name, with no spaces or sign: ${variable}[0] is the first item, ${variable}[1] the second.`,
    params: { variable, index: inside, written: bracket },
    range: index.range(start, start + bracket.length),
    fixes: [],
  };
}

/**
 * Replaces every reference in an unescaped value with lookup(target,
 * variable, index), index the n of VARIABLE[n] or null without one. A null
 * lookup keeps the reference as written and reports it.
 */
export function substituteReferences(
  value: string,
  lookup: (target: string, variable: string, index: number | null) => string | null,
): { value: string; unresolved: { target: string; variable: string }[] } {
  const unresolved: { target: string; variable: string }[] = [];
  const out = value.replace(referencePattern, (raw, target: string, variable: string, digits: string | undefined) => {
    const resolved = lookup(target, variable, digits === undefined ? null : Number(digits));
    if (resolved === null) {
      unresolved.push({ target, variable });
      return raw;
    }
    return resolved;
  });
  return { value: out, unresolved };
}

/** The entry and reference under an offset, for hovers and go-to. */
export function referenceAt(parsed: ParsedEnv, offset: number): { entry: EnvEntry; reference: EnvReference } | null {
  for (const entry of parsed.entries) {
    if (!rangeContains(entry.valueRange, offset) && offset !== entry.valueRange.end) continue;
    for (const reference of entry.references) {
      if (offset >= reference.range.start && offset < reference.range.end) return { entry, reference };
    }
  }
  return null;
}

/** Text to insert for a reference: "${{db.URL}}", with an index "${{api.DOMAINS[1]}}". */
export function formatReference(target: string, variable: string, index?: number | null): string {
  return `\${{${target}.${variable}${index === null || index === undefined ? "" : `[${index}]`}}}`;
}
