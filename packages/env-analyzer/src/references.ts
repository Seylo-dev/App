// ${{target.VARIABLE}} references. target is a service name in the same
// project or "project" for the project's shared variables. Whitespace
// inside the braces is allowed: ${{ db.URL }}.

import { type LineIndex, rangeContains } from "./source";
import type { Diagnostic, EnvEntry, EnvReference, ParsedEnv } from "./types";

/** Reference prefix of the project's shared variables. */
export const sharedTarget = "project";

const open = "${{";
const close = "}}";
const inner = /^(\s*)([A-Za-z0-9_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/;

/** Same grammar as the parser, for substituting references in unescaped values. */
const referencePattern = /\$\{\{\s*([A-Za-z0-9_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

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
    if (!match) {
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
      const targetStart = at + open.length + leading.length;
      const variableStart = targetStart + target.length + 1;
      references.push({
        raw: text.slice(at, end),
        target,
        variable,
        range: index.range(at, end),
        targetRange: index.range(targetStart, targetStart + target.length),
        variableRange: index.range(variableStart, variableStart + variable.length),
      });
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
 * Replaces every reference in an unescaped value with lookup(target,
 * variable). A null lookup keeps the reference as written and reports it.
 */
export function substituteReferences(
  value: string,
  lookup: (target: string, variable: string) => string | null,
): { value: string; unresolved: { target: string; variable: string }[] } {
  const unresolved: { target: string; variable: string }[] = [];
  const out = value.replace(referencePattern, (raw, target: string, variable: string) => {
    const resolved = lookup(target, variable);
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

/** Text to insert for a reference: "${{db.URL}}". */
export function formatReference(target: string, variable: string): string {
  return `\${{${target}.${variable}}}`;
}
