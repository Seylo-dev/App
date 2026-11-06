// Turns @seylo/env-analyzer results into what the Monaco env editor draws:
// translated problem messages, marker data, reference pills, problem-line
// backgrounds and the ranges of secret values. Pure, so it is tested
// without Monaco; env-editor.tsx hands these to the editor.

import type { Diagnostic, ParsedEnv, QuickFix, SourceRange } from "@seylo/env-analyzer";
import { type MessageKey, t } from "../../../i18n/t";

/** Monaco's MarkerSeverity values (Hint 1, Info 2, Warning 4, Error 8), so this file needs no Monaco import. */
export const markerSeverity = { hint: 1, info: 2, warning: 4, error: 8 } as const;

const messageKeys: Record<string, MessageKey> = {
  "invalid-line": "serviceEnv.problem.invalidLine",
  "invalid-key": "serviceEnv.problem.invalidKey",
  "missing-equals": "serviceEnv.problem.missingEquals",
  "unterminated-quote": "serviceEnv.problem.unterminatedQuote",
  "trailing-characters": "serviceEnv.problem.trailingCharacters",
  "unterminated-reference": "serviceEnv.problem.unterminatedReference",
  "malformed-reference": "serviceEnv.problem.malformedReference",
  "duplicate-key": "serviceEnv.problem.duplicateKey",
  "unknown-service": "serviceEnv.problem.unknownService",
  "unknown-variable": "serviceEnv.problem.unknownVariable",
  "self-reference": "serviceEnv.problem.selfReference",
  "reference-cycle": "serviceEnv.problem.referenceCycle",
  "internal-reference-other-node": "serviceEnv.problem.otherNode",
  "internal-address-other-node": "serviceEnv.problem.otherNode",
  "service-not-exposed": "serviceEnv.problem.notExposed",
  "empty-reference": "serviceEnv.problem.emptyReference",
};

const detailKeys: Record<string, MessageKey> = {
  "internal-reference-other-node": "serviceEnv.problem.otherNodeDetail",
  "internal-address-other-node": "serviceEnv.problem.otherNodeDetail",
  "service-not-exposed": "serviceEnv.problem.notExposedDetail",
  "duplicate-key": "serviceEnv.problem.duplicateKeyDetail",
};

/** The problem's one-line message in the catalog's language (the analyzer's English as a last resort). */
export function problemMessage(d: Pick<Diagnostic, "code" | "params" | "message">): string {
  const key = messageKeys[d.code];
  if (!key) return d.message;
  if (d.code === "unknown-service" && d.params.target === "project") return t("serviceEnv.problem.noShared");
  return t(key, d.params);
}

export function problemDetail(d: Pick<Diagnostic, "code" | "params" | "detail">, selfName: string): string {
  const key = detailKeys[d.code];
  return key ? t(key, { ...d.params, self: selfName }) : "";
}

/** Button text for a quick fix. */
export function fixTitle(fix: QuickFix, selfName: string): string {
  switch (fix.kind) {
    case "edit":
      return t("serviceEnv.fix.use", { text: fix.edits[0]?.text ?? "" });
    case "moveService":
      return t("serviceEnv.fix.move", { service: selfName, node: fix.nodeName });
    case "exposeService":
      return t("serviceEnv.fix.expose", { service: fix.serviceName });
  }
}

export interface MarkerData {
  severity: number;
  message: string;
  code: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** Squiggles for every diagnostic. Zero-width ranges are widened by one column so they stay visible. */
export function toMarkers(diagnostics: readonly Diagnostic[], selfName: string): MarkerData[] {
  return diagnostics.map((d) => {
    const detail = problemDetail(d, selfName);
    const sameSpot = d.range.startLine === d.range.endLine && d.range.startColumn === d.range.endColumn;
    return {
      severity: markerSeverity[d.severity],
      message: detail ? `${problemMessage(d)}\n${detail}` : problemMessage(d),
      code: d.code,
      startLineNumber: d.range.startLine,
      startColumn: d.range.startColumn,
      endLineNumber: d.range.endLine,
      endColumn: sameSpot ? d.range.endColumn + 1 : d.range.endColumn,
    };
  });
}

export interface LineRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export function toLineRange(range: SourceRange): LineRange {
  return { startLineNumber: range.startLine, startColumn: range.startColumn, endLineNumber: range.endLine, endColumn: range.endColumn };
}

/** Every ${{...}} reference, for the violet pill decoration. */
export function referenceRanges(parsed: ParsedEnv): LineRange[] {
  return parsed.entries.flatMap((e) => e.references.map((r) => toLineRange(r.range)));
}

/** Lines that hold an error, for the light red line background and red line number. */
export function errorLines(diagnostics: readonly Diagnostic[]): number[] {
  const lines = new Set<number>();
  for (const d of diagnostics) if (d.severity === "error") for (let l = d.range.startLine; l <= d.range.endLine; l++) lines.add(l);
  return [...lines].sort((a, b) => a - b);
}

const secretKey = /(SECRET|PASSWORD|PASSWD|PASS|TOKEN|PRIVATE|API_?KEY|ACCESS_?KEY|_KEY$|^KEY$|DSN|CREDENTIAL|AUTH)/i;
const urlPassword = /:\/\/[^:/@\s]+:([^@\s]+)@/g;
/** scheme://<user info>@ at the start of a value: the password when there is one, else the user (a DSN key). */
const urlUserInfo = /^[a-z][a-z0-9+.-]*:\/\/(?:[^:/@\s]+:)?([^:/@\s]+)@/i;
/** Prefixes that name a token's kind without giving it away. */
const tokenPrefix = /^(?:[a-z]{2,8}_(?:live|test|prod)_|gh[pousr]_|github_pat_|xox[abpr]-|sk-(?:ant-|proj-)?|glpat-|AKIA)/i;

/**
 * Value ranges shown as dots while "Show values" is off (Environment.dc.html):
 * values of keys that look secret, and the password part of URLs
 * (scheme://user:pass@). A secret value keeps what helps to recognise it:
 * a URL keeps everything but its user info (a Sentry DSN shows its host), a
 * token keeps a well-known prefix (sk_live_, ghp_). References are never
 * hidden; they hold no secret themselves.
 */
export function secretRanges(parsed: ParsedEnv): LineRange[] {
  const out: LineRange[] = [];
  for (const entry of parsed.entries) {
    const v = entry.valueRange;
    if (v.start === v.end) continue;
    const raw = parsed.text.slice(v.start, v.end);
    // Columns are offsets into the value, so only one-line values are masked in part.
    const part = (from: number, to: number) =>
      out.push({
        startLineNumber: v.startLine,
        startColumn: v.startColumn + from,
        endLineNumber: v.startLine,
        endColumn: v.startColumn + to,
      });
    if (secretKey.test(entry.key) && entry.references.length === 0) {
      const user = v.startLine === v.endLine ? urlUserInfo.exec(raw) : null;
      const prefix = v.startLine === v.endLine ? (tokenPrefix.exec(raw)?.[0].length ?? 0) : 0;
      if (user?.[1]) {
        const from = (user.index ?? 0) + user[0].length - user[1].length - 1;
        part(from, from + user[1].length);
      } else if (prefix > 0 && prefix < raw.length) part(prefix, raw.length);
      else out.push(toLineRange(v));
      continue;
    }
    if (v.startLine !== v.endLine) continue;
    for (const match of raw.matchAll(urlPassword)) {
      const password = match[1] ?? "";
      if (!password || password.startsWith("${{")) continue;
      const from = (match.index ?? 0) + match[0].indexOf(`:${password}@`) + 1;
      part(from, from + password.length);
    }
  }
  return out;
}

/** "Line 4: db runs on another node" lines for the footer, errors first. */
export function problemSummary(
  diagnostics: readonly Diagnostic[],
): { line: number; text: string; severity: Diagnostic["severity"]; diagnostic: Diagnostic }[] {
  const rank = { error: 0, warning: 1, info: 2, hint: 3 } as const;
  return [...diagnostics]
    .sort((a, b) => rank[a.severity] - rank[b.severity] || a.range.start - b.range.start)
    .map((d) => ({ line: d.range.startLine, text: problemMessage(d), severity: d.severity, diagnostic: d }));
}
