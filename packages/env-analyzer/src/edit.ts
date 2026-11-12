// Changes one variable of a .env text and leaves every other byte as it was,
// so a caller that cannot see the other values (a model through MCP, whose
// env.get values are redacted) can still set one: env.setVariable and
// env.setSharedVariable run this.
//
//   setEnvVariable(text, "API_URL", "${{api.URL}}/v1")  replaces the last API_URL line's value, or appends one
//   setEnvVariable(text, "API_URL", null)              removes every API_URL line

import { escapeDouble, isValidKey, parseEnv } from "./parse";
import type { EnvEntry, ParsedEnv, QuoteStyle } from "./types";

export type EnvEdit =
  | { ok: true; text: string }
  /** invalid-key: not a name the parser takes. not-set: nothing to remove. invalid-value: no quoting writes it back as given. */
  | { ok: false; reason: "invalid-key" | "not-set" | "invalid-value"; message: string };

/**
 * Sets key to value (null removes it). An existing key keeps its line: the
 * value of the last line with that key (the one that wins) is replaced, with
 * its quote style when the new value reads back the same in it (else double
 * quotes), its "export", its trailing comment and the comment lines above
 * it. A new key is appended as KEY=value. Removing drops every line with the
 * key and a "# @public"/"# @secret" line right above one (it would apply to
 * the next line otherwise). Values with a newline are written in quotes.
 */
export function setEnvVariable(text: string, key: string, value: string | null): EnvEdit {
  if (!isValidKey(key)) {
    return {
      ok: false,
      reason: "invalid-key",
      message: `${key} is not a valid variable name: start with a letter or _, then letters, digits, _, . or -.`,
    };
  }
  const parsed = parseEnv(text);
  const same = parsed.entries.filter((e) => e.key === key);
  if (value === null) {
    if (same.length === 0) return { ok: false, reason: "not-set", message: `${key} is not set.` };
    return { ok: true, text: remove(parsed, same) };
  }

  const last = same.at(-1);
  if (!last) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const before = text === "" || text.endsWith("\n") ? text : `${text}${newline}`;
    for (const style of ["none", "double"] as const) {
      const raw = render(value, style);
      if (raw === null) continue;
      const next = `${before}${key}=${raw}${newline}`;
      if (readsBack(parsed, next, key, value, 1)) return { ok: true, text: next };
    }
    return unwritable(key, value);
  }

  // "KEY= # note": an empty value sits right before the comment, which needs its blank to stay one.
  const after = text.slice(last.valueRange.end);
  const gap = last.valueRange.start === last.valueRange.end && after.startsWith("#") ? " " : "";
  for (const style of stylesFor(last.quote)) {
    const raw = render(value, style);
    if (raw === null) continue;
    const next = text.slice(0, last.valueRange.start) + raw + (raw === "" ? "" : gap) + after;
    if (readsBack(parsed, next, key, value, 0)) return { ok: true, text: next };
  }
  return unwritable(key, value);
}

/** The old style first when the value fits it, double quotes (which write anything) after. */
function stylesFor(quote: QuoteStyle): QuoteStyle[] {
  return quote === "double" ? ["double"] : [quote, "double"];
}

function render(value: string, style: QuoteStyle): string | null {
  switch (style) {
    case "none":
      // The rule stringifyEnv quotes by: no blanks, quotes, # or backslash.
      return value === "" || /^[^\s"'`#\\]+$/.test(value) ? value : null;
    case "double":
      return `"${escapeDouble(value)}"`;
    case "single":
      // Single quotes take no references: a value with one goes in double quotes.
      return value.includes("'") || value.includes("${{") ? null : `'${value}'`;
    case "backtick":
      return value.includes("`") ? null : `\`${value}\``;
  }
}

/** The edited text parses to the same entries and comments plus `added`, with no new problems, and key's last value is value. */
function readsBack(before: ParsedEnv, text: string, key: string, value: string, added: number): boolean {
  const after = parseEnv(text);
  if (after.entries.length !== before.entries.length + added || after.comments.length !== before.comments.length) return false;
  if (after.problems.length > before.problems.length) return false;
  return after.entries.findLast((e) => e.key === key)?.value === value;
}

function unwritable(key: string, value: string): EnvEdit {
  // Say what is wrong with the value without repeating it (it can be a secret).
  const problem = parseEnv(`${key}=${render(value, "double")}\n`).problems[0];
  return {
    ok: false,
    reason: "invalid-value",
    message: problem ? `The value of ${key}: ${problem.message}.` : `The value of ${key} cannot be written to a .env file.`,
  };
}

function remove(parsed: ParsedEnv, entries: readonly EnvEntry[]): string {
  const { text } = parsed;
  const cuts = entries.map((entry) => {
    let from = entry.range.start - (entry.range.startColumn - 1);
    const newline = text.indexOf("\n", entry.range.end);
    const to = newline === -1 ? text.length : newline + 1;
    const annotation = parsed.comments.find((c) => {
      const lineStart = c.range.start - (c.range.startColumn - 1);
      const ownLine = text.slice(lineStart, c.range.start).trim() === "";
      const word = c.text.trim().split(/\s+/)[0]?.toLowerCase();
      return ownLine && c.range.endLine === entry.range.startLine - 1 && (word === "@public" || word === "@secret");
    });
    if (annotation) from = annotation.range.start - (annotation.range.startColumn - 1);
    return { from, to };
  });
  let out = text;
  for (const cut of cuts.sort((a, b) => b.from - a.from)) out = out.slice(0, cut.from) + out.slice(cut.to);
  return out;
}
