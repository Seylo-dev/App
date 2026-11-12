// References the app gets as plain text. Single quotes keep their text as
// written, so API='${{api.URL}}' hands the app the characters ${{api.URL}},
// and API=api.URL without ${{ }} is the text api.URL. Both save and deploy
// fine and are almost always meant as references, so the analyzer warns,
// with the value in double quotes or the token in ${{ }} as the fix. As in
// hardcoded.ts, values can be secrets and the MCP server hands diagnostics
// to models: message, detail, params and fixes name the key, the reference
// or the token, never the rest of the value.

import { builtinNames } from "./builtins";
import { escapeDouble, parseEnv } from "./parse";
import { formatReference, scanReferences, sharedTarget } from "./references";
import { selfTarget } from "./resolve";
import type { LineIndex } from "./source";
import { closestNames } from "./suggest";
import type { AnalyzeContext, Diagnostic, EnvEntry, EnvReference, QuickFix, TextEdit } from "./types";

/** single-quoted-reference: one warning per well-formed ${{target.VARIABLE}} inside a single-quoted value. */
export function checkSingleQuoted(index: LineIndex, entry: EnvEntry): Diagnostic[] {
  if (entry.quote !== "single") return [];
  const { references } = scanReferences(index, entry.valueRange.start + 1, entry.valueRange.end - 1);
  if (references.length === 0) return [];
  const fixes = doubleQuoted(index, entry, references);
  return references.map((reference) => ({
    code: "single-quoted-reference",
    severity: "warning",
    message: `Single quotes keep ${reference.raw} as text: the app gets it literally`,
    detail: `Double quotes replace ${reference.raw} with its value; single quotes are for text that has to stay as written.`,
    params: { key: entry.key, reference: reference.raw, target: reference.target, variable: reference.variable },
    range: reference.range,
    fixes,
  }));
}

/**
 * The value in double quotes: both quotes replaced, and outside the
 * references each \, ", $, line break and tab escaped the way the parser
 * reads it back. One small edit per character, so the fix never carries
 * the value. None when the result would not read back as the same text
 * with the same references (a CRLF line break inside the value, a broken
 * ${{ next to the reference).
 */
function doubleQuoted(index: LineIndex, entry: EnvEntry, references: readonly EnvReference[]): QuickFix[] {
  const { text } = index;
  const { start, end } = entry.valueRange;
  const edits: TextEdit[] = [{ range: index.range(start, start + 1), text: '"' }];
  let written = '"';
  let next = 0;
  for (let i = start + 1; i < end - 1; i++) {
    // References come in source order and are copied as written.
    const reference = references[next];
    if (reference && i === reference.range.start) {
      written += reference.raw;
      i = reference.range.end - 1;
      next++;
      continue;
    }
    const ch = text.charAt(i);
    const escaped = ch === "$" ? "\\$" : escapeDouble(ch);
    if (escaped !== ch) edits.push({ range: index.range(i, i + 1), text: escaped });
    written += escaped;
  }
  edits.push({ range: index.range(end - 1, end), text: '"' });
  written += '"';

  const back = parseEnv(`K=${written}`);
  const entryBack = back.entries[0];
  const same =
    back.problems.length === 0 &&
    back.comments.length === 0 &&
    back.entries.length === 1 &&
    entryBack?.value === entry.value &&
    entryBack.references.length === references.length;
  return same ? [{ kind: "edit", title: "Use double quotes", edits }] : [];
}

/** Characters of a reference's target and variable names (the target may also have "-", but not first). */
const nameChar = /[A-Za-z0-9_-]/;
const variableChar = /[A-Za-z0-9_]/;
/** A variable name in capitals: what references point at, unlike file.txt or api.domain. */
const upperVariable = /^[A-Z_][A-Z0-9_]*$/;
/** What may come right before a token ("/" too, but not "//": a host after "://" or "//"). */
const leftDelimiter = /[\s"'`,;=:|(<[]/;
/** What may come right after one. Not ".", which makes it part of a longer name (api.DOMAIN.com), nor "@" or "=". */
const rightDelimiter = /[\s"'`,;/:|?#&)>\]]/;
/** A service name as @seylo/ops ServiceName takes it (DNS-safe, lower case), with a letter in it. */
const serviceNameShape = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
/** Stands in for text inside ${{ }}: neither part of a token nor a delimiter. */
const masked = "\0";

/**
 * bare-reference: a name.VARIABLE token in an unquoted or double-quoted
 * value, delimited by blanks, quotes, commas, slashes and the like, where
 * name is a target with that variable (the fix wraps it in ${{ }}), or
 * VARIABLE is a built-in name and name a target without it or something
 * shaped like a service name (no wrap; a typo of a target that has the
 * variable gets "Did you mean" fixes). VARIABLE must be an exact variable
 * name in capitals, so example.com, file.txt, api.domain and 1.2 never match.
 */
export function checkBareReferences(index: LineIndex, entry: EnvEntry, context: AnalyzeContext): Diagnostic[] {
  if (entry.quote !== "none" && entry.quote !== "double") return [];
  const quoted = entry.quote === "double";
  const start = entry.valueRange.start + (quoted ? 1 : 0);
  const end = entry.valueRange.end - (quoted ? 1 : 0);
  if (end <= start) return [];
  const scan = scannable(index.text.slice(start, end), quoted);

  const out: Diagnostic[] = [];
  // From each dot outwards over name characters: linear, where a regex would backtrack over long values without one.
  for (let dot = scan.indexOf("."); dot !== -1; dot = scan.indexOf(".", dot + 1)) {
    let at = dot;
    while (at > 0 && nameChar.test(scan.charAt(at - 1))) at--;
    while (scan.charAt(at) === "-") at++;
    let after = dot + 1;
    while (after < scan.length && variableChar.test(scan.charAt(after))) after++;
    const name = scan.slice(at, dot);
    const variable = scan.slice(dot + 1, after);
    if (name === "" || !upperVariable.test(variable) || !/[A-Z]/.test(variable)) continue;
    const before = scan.charAt(at - 1);
    if (at > 0 && !leftDelimiter.test(before) && !(before === "/" && scan.charAt(at - 2) !== "/")) continue;
    if (after < scan.length && !rightDelimiter.test(scan.charAt(after))) continue;
    const diagnostic = bareReference(index, entry, context, start + at, `${name}.${variable}`, name, variable);
    if (diagnostic) out.push(diagnostic);
  }
  return out;
}

function bareReference(
  index: LineIndex,
  entry: EnvEntry,
  context: AnalyzeContext,
  from: number,
  token: string,
  name: string,
  variable: string,
): Diagnostic | null {
  const own = selfTarget(context);
  const isSelf = name !== sharedTarget && name.toLowerCase() === context.self.name.toLowerCase();
  const target = isSelf ? own : (context.targets.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null);
  const known = target?.variables.some((v) => v.name === variable) ?? false;
  if (!known) {
    if (!builtinNames.has(variable)) return null;
    if (!target && !isSelf && !(serviceNameShape.test(name) && /[a-z]/.test(name))) return null;
  }

  const range = index.range(from, from + token.length);
  const use = (reference: string): QuickFix => ({ kind: "edit", title: `Use ${reference}`, edits: [{ range, text: reference }] });
  const wrapped = formatReference(name, variable);
  const reference = known && target ? formatReference(target.name, variable) : "";
  // A typo of a target that has the variable: "Did you mean", like unknown-service.
  const candidates = !target && !isSelf ? [...(own ? [own] : []), ...context.targets] : [];
  const suggestions = closestNames(
    name,
    candidates.filter((t) => t.variables.some((v) => v.name === variable)).map((t) => t.name),
  );
  const reason = reference ? "reference" : target || isSelf ? "noVariable" : "unknownService";

  const base = `Looks like a reference written without \${{ }}: the app gets the text ${token}`;
  const message = suggestions.length > 0 ? `${base}. Did you mean ${suggestions.join(", ")}?` : base;
  const detail =
    reason === "reference"
      ? `Wrap it in \${{ }} to use ${target?.name ?? name}'s ${variable}: ${reference}.`
      : reason === "noVariable"
        ? `${name} has no ${variable}, so ${wrapped} would not work either.`
        : name === sharedTarget
          ? `This project has no shared variables, so ${wrapped} would not work either.`
          : `There is no service named ${name} in this project.`;
  return {
    code: "bare-reference",
    severity: "warning",
    message,
    detail,
    params: { key: entry.key, token, target: target?.name ?? name, variable, reference, wrapped, reason, suggestions: suggestions.join(", ") },
    range,
    fixes: reference ? [use(reference)] : suggestions.map((s) => use(formatReference(s, variable))),
  };
}

/**
 * The value with what can never be a token blanked out, same length so
 * offsets stay: text inside ${{ }} (and a broken ${{ up to the end of its
 * line) becomes a character that is no delimiter, and in double quotes an
 * escape such as \n becomes two blanks.
 */
function scannable(raw: string, quoted: boolean): string {
  const out = raw.replace(/\$\{\{.*?(?:\}\}|$)/gm, (text) => masked.repeat(text.length));
  return quoted ? out.replace(/\\[^]/g, "  ") : out;
}
