import { describe, expect, test } from "bun:test";
import { parseEnv, referenceAt, stringifyEnv, substituteReferences } from "../src";

const slice = (text: string, range: { start: number; end: number }) => text.slice(range.start, range.end);

describe("parseEnv", () => {
  test("plain entries, comments, blanks and export", () => {
    const text = "# worker\n\nNODE_ENV=production\nexport PORT = 3000 # http\nEMPTY=\n";
    const parsed = parseEnv(text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map((e) => [e.key, e.value, e.exported])).toEqual([
      ["NODE_ENV", "production", false],
      ["PORT", "3000", true],
      ["EMPTY", "", false],
    ]);
    expect(parsed.comments.map((c) => c.text)).toEqual([" worker", " http"]);
    const port = parsed.entries[1];
    expect(port && slice(text, port.keyRange)).toBe("PORT");
    expect(port && slice(text, port.valueRange)).toBe("3000");
    expect(port?.keyRange.startLine).toBe(4);
    expect(port?.keyRange.startColumn).toBe(8);
    const empty = parsed.entries[2];
    expect(empty?.valueRange.start).toBe(empty?.valueRange.end);
  });

  test("double quotes unescape and may span lines; single quotes are raw", () => {
    const text = 'A="line1\\nline2 \\"q\\" \\$HOME"\nB=\'raw \\n $x\'\nC="multi\nline"\nD=`tick`\n';
    const parsed = parseEnv(text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map((e) => [e.key, e.value, e.quote])).toEqual([
      ["A", 'line1\nline2 "q" $HOME', "double"],
      ["B", "raw \\n $x", "single"],
      ["C", "multi\nline", "double"],
      ["D", "tick", "backtick"],
    ]);
    const c = parsed.entries[2];
    expect(c?.valueRange.startLine).toBe(3);
    expect(c?.valueRange.endLine).toBe(4);
  });

  test("a # inside an unquoted value only starts a comment after whitespace", () => {
    const parsed = parseEnv("URL=https://x.io/#frag\nCOLOR=#fff\nX=a #b\n");
    expect(parsed.entries.map((e) => e.value)).toEqual(["https://x.io/#frag", "", "a"]);
  });

  test("CRLF line endings", () => {
    const text = 'A=1\r\nB="two"\r\n';
    const parsed = parseEnv(text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map((e) => e.value)).toEqual(["1", "two"]);
    expect(parsed.entries[0]?.valueRange.endColumn).toBe(4);
  });

  test("syntax problems are reported with ranges and parsing continues", () => {
    const text = 'just words\n1BAD=x\nNOEQ value\nOPEN="never closed\nAFTER="ok" junk\nGOOD=yes\n';
    const parsed = parseEnv(text);
    expect(parsed.problems.map((p) => [p.code, p.range.startLine])).toEqual([
      ["missing-equals", 1],
      ["invalid-key", 2],
      ["missing-equals", 3],
      ["unterminated-quote", 4],
      ["trailing-characters", 5],
    ]);
    expect(parsed.entries.map((e) => e.key)).toEqual(["1BAD", "OPEN", "AFTER", "GOOD"]);
    expect(parsed.entries.at(-1)?.value).toBe("yes");
  });

  test("a line with no key is invalid", () => {
    const parsed = parseEnv("=value\n");
    expect(parsed.problems.map((p) => p.code)).toEqual(["invalid-line"]);
    expect(parsed.entries).toEqual([]);
  });
});

describe("references", () => {
  test("found with exact source ranges", () => {
    const text = "DATABASE_URL=${{db.EXPOSED_URL}}\nAPI=\"${{ api.URL }}/v1\"\nRAW='${{db.URL}}'\n";
    const parsed = parseEnv(text);
    expect(parsed.problems).toEqual([]);
    const [db, api, raw] = parsed.entries;
    expect(db?.references.map((r) => [r.target, r.variable, r.raw])).toEqual([["db", "EXPOSED_URL", "${{db.EXPOSED_URL}}"]]);
    const ref = db?.references[0];
    expect(ref && slice(text, ref.range)).toBe("${{db.EXPOSED_URL}}");
    expect(ref && slice(text, ref.targetRange)).toBe("db");
    expect(ref && slice(text, ref.variableRange)).toBe("EXPOSED_URL");
    expect(ref?.range.startColumn).toBe(14);
    const apiRef = api?.references[0];
    expect(apiRef && slice(text, apiRef.targetRange)).toBe("api");
    expect(apiRef?.range.startLine).toBe(2);
    expect(raw?.references).toEqual([]);
  });

  test("several references in one value", () => {
    const parsed = parseEnv("X=${{a.H}}:${{a.P}}/${{project.DB}}\n");
    expect(parsed.entries[0]?.references.map((r) => `${r.target}.${r.variable}`)).toEqual(["a.H", "a.P", "project.DB"]);
  });

  test("broken references are syntax errors", () => {
    const parsed = parseEnv("A=${{db.URL\nB=${{nodot}}\nC=${{db.}}\n");
    expect(parsed.problems.map((p) => [p.code, p.range.startLine])).toEqual([
      ["unterminated-reference", 1],
      ["malformed-reference", 2],
      ["malformed-reference", 3],
    ]);
  });

  test("referenceAt finds the reference under an offset", () => {
    const text = "A=x ${{db.URL}} y\n";
    const parsed = parseEnv(text);
    expect(referenceAt(parsed, text.indexOf("db"))?.reference.variable).toBe("URL");
    expect(referenceAt(parsed, text.indexOf("x"))).toBeNull();
  });

  test("substituteReferences keeps unknown references as written", () => {
    const result = substituteReferences("${{db.HOST}}:${{db.NOPE}}", (_t, v) => (v === "HOST" ? "10.0.0.1" : null));
    expect(result.value).toBe("10.0.0.1:${{db.NOPE}}");
    expect(result.unresolved).toEqual([{ target: "db", variable: "NOPE" }]);
  });
});

describe("stringifyEnv", () => {
  test("round trips through parseEnv", () => {
    const vars = [
      { key: "A", value: "plain" },
      { key: "B", value: "has space" },
      { key: "C", value: 'quote " and \\ and\nnewline' },
      { key: "D", value: "" },
      { key: "E", value: "#hash" },
    ];
    const parsed = parseEnv(stringifyEnv(vars));
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map((e) => ({ key: e.key, value: e.value }))).toEqual(vars);
  });
});
