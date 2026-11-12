// A dotenv parser that keeps source ranges, so editors can underline the
// exact characters a problem is about. The accepted syntax is what
// dotenv and godotenv agree on:
//
//   # comment
//   KEY=value            unquoted: trimmed, " #" starts a comment
//   export KEY=value     "export " is allowed and remembered
//   KEY = value          spaces around "=" are allowed
//   KEY="a\nb ${{db.URL}}"   double quotes: \n \r \t \" \\ \$ escapes, may span lines
//   KEY='raw $x'         single quotes (and backticks): taken as is, may span lines, no references
//
// The parser never throws: every problem becomes a Diagnostic and the
// rest of the file is still parsed.

import { scanReferences } from "./references";
import { LineIndex } from "./source";
import type { Diagnostic, EnvComment, EnvEntry, ParsedEnv, QuoteStyle } from "./types";

const keyPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const keyChar = /[A-Za-z0-9_.-]/;

/** A name the parser takes as a key: a letter or _, then letters, digits, _, . or -. */
export function isValidKey(key: string): boolean {
  return keyPattern.test(key);
}

export function parseEnv(text: string): ParsedEnv {
  const index = new LineIndex(text);
  const entries: EnvEntry[] = [];
  const comments: EnvComment[] = [];
  const problems: Diagnostic[] = [];

  const problem = (
    code: Diagnostic["code"],
    start: number,
    end: number,
    message: string,
    detail = "",
    severity: Diagnostic["severity"] = "error",
  ) => problems.push({ code, severity, message, detail, params: {}, range: index.range(start, end), fixes: [] });

  let pos = 0;
  while (pos < text.length) {
    const lineEnd = endOfLine(text, pos);
    let i = skipBlanks(text, pos, lineEnd);
    if (i >= lineEnd) {
      pos = lineEnd + 1;
      continue;
    }
    if (text[i] === "#") {
      comments.push({ text: text.slice(i + 1, lineEnd), range: index.range(i, lineEnd) });
      pos = lineEnd + 1;
      continue;
    }

    const entryStart = i;
    let exported = false;
    if (text.startsWith("export", i) && (text[i + 6] === " " || text[i + 6] === "\t")) {
      exported = true;
      i = skipBlanks(text, i + 6, lineEnd);
    }
    const keyStart = i;
    while (i < lineEnd && keyChar.test(text[i] ?? "")) i++;
    const key = text.slice(keyStart, i);
    if (key === "") {
      problem("invalid-line", entryStart, lineEnd, "Each line should be KEY=value or a # comment");
      pos = lineEnd + 1;
      continue;
    }
    const afterKey = skipBlanks(text, i, lineEnd);
    if (text[afterKey] !== "=") {
      problem(
        "missing-equals",
        entryStart,
        lineEnd,
        `${key} is missing "="`,
        "Write KEY=value; leave the value empty for an empty variable.",
      );
      pos = lineEnd + 1;
      continue;
    }
    if (!keyPattern.test(key)) {
      problem(
        "invalid-key",
        keyStart,
        i,
        `${key} is not a valid variable name`,
        "Names start with a letter or _ and contain letters, digits, _, . or -.",
      );
    }

    const valueStart = skipBlanks(text, afterKey + 1, lineEnd);
    const quoteChar = text[valueStart];
    let quote: QuoteStyle = "none";
    let value: string;
    let valueEnd: number;
    let nextPos: number;
    let refsFrom = valueStart;
    let refsTo: number;

    if (quoteChar === '"' || quoteChar === "'" || quoteChar === "`") {
      quote = quoteChar === '"' ? "double" : quoteChar === "'" ? "single" : "backtick";
      let closeAt = findClosingQuote(text, valueStart, quoteChar);
      // A quote that closes on a later line followed by more text is far more
      // likely a forgotten quote than a multi-line value: report it here.
      if (closeAt > lineEnd && skipBlanks(text, closeAt + 1, endOfLine(text, closeAt)) < endOfLine(text, closeAt)) {
        const after = text[skipBlanks(text, closeAt + 1, endOfLine(text, closeAt))];
        if (after !== "#") closeAt = -1;
      }
      if (closeAt === -1) {
        problem("unterminated-quote", valueStart, lineEnd, `The value of ${key} has no closing ${quoteChar}`);
        valueEnd = lineEnd;
        value = text.slice(valueStart + 1, lineEnd);
        refsFrom = valueStart + 1;
        refsTo = lineEnd;
        nextPos = lineEnd + 1;
      } else {
        const raw = text.slice(valueStart + 1, closeAt);
        value = quote === "double" ? unescapeDouble(raw) : raw;
        valueEnd = closeAt + 1;
        refsFrom = valueStart + 1;
        refsTo = closeAt;
        const closeLineEnd = endOfLine(text, closeAt);
        const rest = skipBlanks(text, valueEnd, closeLineEnd);
        if (rest < closeLineEnd) {
          if (text[rest] === "#") {
            comments.push({ text: text.slice(rest + 1, closeLineEnd), range: index.range(rest, closeLineEnd) });
          } else {
            problem(
              "trailing-characters",
              rest,
              closeLineEnd,
              `Unexpected text after the closing ${quoteChar}`,
              "Put a # before a comment.",
            );
          }
        }
        nextPos = closeLineEnd + 1;
      }
    } else {
      let end = lineEnd;
      for (let k = valueStart; k < lineEnd; k++) {
        if (text[k] === "#" && (k === valueStart || text[k - 1] === " " || text[k - 1] === "\t")) {
          comments.push({ text: text.slice(k + 1, lineEnd), range: index.range(k, lineEnd) });
          end = k;
          break;
        }
      }
      value = text.slice(valueStart, end).trimEnd();
      valueEnd = valueStart + value.length;
      refsTo = valueEnd;
      nextPos = lineEnd + 1;
    }

    const scanned = quote === "single" ? { references: [], problems: [] } : scanReferences(index, refsFrom, refsTo);
    problems.push(...scanned.problems);
    entries.push({
      key,
      value,
      exported,
      quote,
      range: index.range(entryStart, valueEnd),
      keyRange: index.range(keyStart, keyStart + key.length),
      valueRange: index.range(valueStart, valueEnd),
      references: scanned.references,
    });
    pos = nextPos;
  }

  problems.sort((a, b) => a.range.start - b.range.start);
  return { text, entries, comments, problems };
}

/** Offset of the line's end, before a "\r\n" or "\n"; text.length on the last line. */
function endOfLine(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  const end = newline === -1 ? text.length : newline;
  return end > from && text[end - 1] === "\r" ? end - 1 : end;
}

function skipBlanks(text: string, from: number, limit: number): number {
  let i = from;
  while (i < limit && (text[i] === " " || text[i] === "\t")) i++;
  return i;
}

function findClosingQuote(text: string, openAt: number, quote: string): number {
  for (let i = openAt + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && quote === '"') {
      i++;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", $: "$" };

function unescapeDouble(raw: string): string {
  return raw.replace(/\\(.)/gs, (all, ch: string) => escapes[ch] ?? all).replace(/\r\n/g, "\n");
}

/** Serializes variables back to .env text, quoting only values that need it. */
export function stringifyEnv(variables: readonly { key: string; value: string }[]): string {
  return variables.map(({ key, value }) => `${key}=${quoteIfNeeded(value)}`).join("\n") + (variables.length > 0 ? "\n" : "");
}

function quoteIfNeeded(value: string): string {
  if (value === "" || /^[^\s"'`#\\]+$/.test(value)) return value;
  return `"${escapeDouble(value)}"`;
}

const doubleEscapes: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** Text that reads back as value between double quotes: \, ", line breaks and tabs escaped (references stay references). */
export function escapeDouble(value: string): string {
  return value.replace(/[\\"\n\r\t]/g, (ch) => doubleEscapes[ch] ?? ch);
}
