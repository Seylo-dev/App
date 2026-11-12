// Turns @seylo/env-analyzer results into what the Monaco env editor draws:
// translated problem messages, marker data, reference pills, problem-line
// backgrounds, the ranges of secret values and the Secret / Public chips.
// Pure, so it is tested without Monaco; env-editor.tsx hands these to the
// editor.

import {
  type AnalyzeContext,
  classifyEntries,
  type Diagnostic,
  type ParsedEnv,
  publicPrefixOf,
  type QuickFix,
  type SecretVerdict,
  type SourceRange,
  secretOverride,
  type TextEdit,
} from "@seylo/env-analyzer";
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
  "hardcoded-reference": "serviceEnv.problem.hardcodedReference",
};

const hardcodedReasons: Record<string, MessageKey> = {
  same: "serviceEnv.problem.hardcodedReferenceSame",
  public: "serviceEnv.problem.hardcodedReferencePublic",
  noPublic: "serviceEnv.problem.hardcodedReferenceNoPublic",
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
  // No public address to switch to: the internal reference would not work in a browser either.
  if (d.code === "hardcoded-reference" && d.params.reason === "noPublic")
    return t("serviceEnv.problem.hardcodedReferenceUnreachable", d.params);
  return t(key, d.params);
}

export function problemDetail(d: Pick<Diagnostic, "code" | "params" | "detail">, selfName: string): string {
  // What the service can reference of itself instead (its DOMAIN, URL, ...), when the panel sent them.
  if (d.code === "self-reference") return d.params.builtins ? t("serviceEnv.problem.selfReferenceDetail", d.params) : "";
  if (d.code === "hardcoded-reference") return hardcodedDetail(d.params);
  const key = detailKeys[d.code];
  return key ? t(key, { ...d.params, self: selfName }) : "";
}

/** Why the reference is better, and for another service's public URL, where INTERNAL_URL works instead. */
function hardcodedDetail(params: Record<string, string>): string {
  const reason =
    params.reason === "noPublic" && params.publicReference
      ? "serviceEnv.problem.hardcodedReferenceNoPublicThen"
      : hardcodedReasons[params.reason ?? ""];
  const parts = reason ? [t(reason, params)] : [];
  if (params.internalReference) {
    parts.push(
      t(
        params.browser === "true"
          ? "serviceEnv.problem.hardcodedReferenceInternalBrowser"
          : "serviceEnv.problem.hardcodedReferenceInternalServer",
        params,
      ),
    );
  }
  return parts.join(" ");
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

export interface QuickFixAction {
  title: string;
  /** Monaco's preferred action (Cmd+. puts it first): the first fix of the most severe problem. */
  isPreferred: boolean;
  /** Monaco MarkerSeverity of the diagnostic it fixes: a hardcoded-reference hint stays an info, not an error. */
  severity: number;
  diagnostic: Diagnostic;
  edits: readonly TextEdit[];
}

/** The edit fixes of every diagnostic touching offsets [from, to], for Monaco's code actions (the lightbulb). */
export function quickFixActions(diagnostics: readonly Diagnostic[], from: number, to: number, selfName: string): QuickFixAction[] {
  const out: Omit<QuickFixAction, "isPreferred">[] = [];
  for (const d of diagnostics) {
    if (d.range.end < from || d.range.start > to) continue;
    for (const fix of d.fixes) {
      if (fix.kind !== "edit") continue;
      out.push({ title: fixTitle(fix, selfName), severity: markerSeverity[d.severity], diagnostic: d, edits: fix.edits });
    }
  }
  // Stable: errors before hints, each in file order.
  return out.sort((a, b) => b.severity - a.severity).map((action, i) => ({ ...action, isPreferred: i === 0 }));
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
 * values of keys that look secret or have a "# @secret" comment, and the
 * password part of URLs (scheme://user:pass@). A key with a framework
 * public prefix (NEXT_PUBLIC_, VITE_, ...) or a "# @public" comment is not
 * hidden whole: every browser gets its value. A secret value keeps what
 * helps to recognise it: a URL keeps everything but its user info (a
 * Sentry DSN shows its host), a token keeps a well-known prefix (sk_live_,
 * ghp_). References are never hidden; they hold no secret themselves.
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
    const override = secretOverride(parsed, entry);
    const secretByName = override === null && publicPrefixOf(entry.key) === null && secretKey.test(entry.key);
    if ((override === "secret" || secretByName) && entry.references.length === 0) {
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

/** A Secret or Public chip at the end of a variable's last line, with its hover. */
export interface SecretChip {
  /** Line the chip ends (the entry's last line). */
  line: number;
  /** The variable's name, where the hover also shows. */
  keyRange: LineRange;
  secret: boolean;
  /** Markdown paragraphs for the hover. */
  hover: string[];
}

const reasonKeys: Record<Exclude<SecretVerdict["reason"], "publicPrefix" | "publicName" | "comment" | "none">, MessageKey> = {
  name: "serviceEnv.secret.whyName",
  value: "serviceEnv.secret.whyValue",
  reference: "serviceEnv.secret.whyReference",
};

/** The hover of one variable's chip: what it is, why, what that changes and how to change it. */
export function secretHover(key: string, verdict: SecretVerdict): string[] {
  const code = (text: string) => `\`${text}\``;
  if (verdict.secret) {
    const why = verdict.publicPrefix
      ? // A password under a framework public prefix: say why the prefix did not make it public.
        verdict.reason === "reference"
        ? t("serviceEnv.secret.whyPrefixReference", { reference: code(verdict.detail ?? ""), prefix: code(verdict.publicPrefix) })
        : t("serviceEnv.secret.whyPrefixValue", { prefix: code(verdict.publicPrefix) })
      : verdict.reason === "comment"
        ? t("serviceEnv.secret.whySecretComment", { comment: code("# @secret") })
        : verdict.reason in reasonKeys
          ? t(reasonKeys[verdict.reason as keyof typeof reasonKeys], { reference: code(verdict.detail ?? "") })
          : "";
    return [
      `**${t("serviceEnv.secret.secretTitle", { key: code(key) })}**${why ? ` - ${why}` : ""}`,
      t("serviceEnv.secret.secretEffect", { mount: code(`RUN --mount=type=secret,id=${key}`), arg: code(`ARG ${key}`) }),
      t("serviceEnv.secret.makePublic", { comment: code("# @public") }),
    ];
  }
  const why =
    verdict.reason === "publicPrefix"
      ? t("serviceEnv.secret.whyPrefix", { prefix: code(verdict.detail ?? "") })
      : verdict.reason === "publicName"
        ? t("serviceEnv.secret.whyPublicName", { key: code(key) })
        : t("serviceEnv.secret.whyPublicComment", { comment: code("# @public") });
  return [
    `**${t("serviceEnv.secret.publicTitle", { key: code(key) })}** - ${why}`,
    t("serviceEnv.secret.publicEffect", { arg: code(`ARG ${key}`) }),
    t("serviceEnv.secret.makeSecret", { comment: code("# @secret") }),
  ];
}

/**
 * Chips for the variables builds and crash reports treat as secrets
 * (env-analyzer classifyEntries with the panel's context, so references
 * to secrets count), and for public ones whose name or value looks secret
 * (a framework public prefix, a "# @public" comment, or GIT_SHA set to a
 * commit id). Plain variables get none.
 */
export function secretChips(parsed: ParsedEnv, context: AnalyzeContext | null, selfName: string): SecretChip[] {
  const ctx: AnalyzeContext = context ?? { self: { serviceId: null, name: selfName, nodes: [] }, targets: [] };
  const verdicts = classifyEntries(parsed, ctx);
  const out: SecretChip[] = [];
  parsed.entries.forEach((entry, i) => {
    const verdict = verdicts[i];
    if (!verdict || !(verdict.secret || verdict.overridesGuess)) return;
    out.push({
      line: entry.range.endLine,
      keyRange: toLineRange(entry.keyRange),
      secret: verdict.secret,
      hover: secretHover(entry.key, verdict),
    });
  });
  return out;
}
