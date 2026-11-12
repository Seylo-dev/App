// Public types of the env analyzer. The web editor (Monaco), the panel and
// the MCP server all speak these shapes; the panel's env.references op
// returns an AnalyzeContext as is, so the editor can analyze unsaved text
// locally without a round trip per keystroke.

/**
 * A span of the source text. Offsets are UTF-16 code units (JavaScript
 * string indexes), end exclusive. Lines and columns are 1-based like
 * Monaco's, and endColumn is exclusive, so a range maps straight to an
 * IRange: { startLineNumber: startLine, startColumn, endLineNumber: endLine, endColumn }.
 */
export interface SourceRange {
  start: number;
  end: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export type QuoteStyle = "none" | "single" | "double" | "backtick";

/** A ${{target.VARIABLE}} reference inside a value. */
export interface EnvReference {
  /** Exactly as written, for example "${{ db.URL }}". */
  raw: string;
  /** Service name, or "project" for the project's shared variables. */
  target: string;
  variable: string;
  /** The whole ${{...}}. */
  range: SourceRange;
  targetRange: SourceRange;
  variableRange: SourceRange;
}

export interface EnvEntry {
  key: string;
  /** Unquoted and unescaped; references are left as written. */
  value: string;
  /** Written as "export KEY=value". */
  exported: boolean;
  quote: QuoteStyle;
  /** From the first character of the key (or "export") to the end of the value. */
  range: SourceRange;
  keyRange: SourceRange;
  /** The value as written, quotes included. Empty values have a zero-width range after "=". */
  valueRange: SourceRange;
  /** References in the value, in source order. Single-quoted values have none. */
  references: EnvReference[];
}

export interface EnvComment {
  /** Text after "#", untrimmed. */
  text: string;
  range: SourceRange;
}

export interface ParsedEnv {
  text: string;
  entries: EnvEntry[];
  comments: EnvComment[];
  /** Syntax problems found while parsing (codes in SyntaxCode). */
  problems: Diagnostic[];
}

export type Severity = "error" | "warning" | "info" | "hint";

export type SyntaxCode =
  | "invalid-line"
  | "invalid-key"
  | "missing-equals"
  | "unterminated-quote"
  | "trailing-characters"
  | "unterminated-reference"
  | "malformed-reference";

export type ContextCode =
  | "duplicate-key"
  | "unknown-service"
  | "unknown-variable"
  | "self-reference"
  /** ${{svc.INTERNAL_*}} of a service that has no instance on every node this service runs on. */
  | "internal-reference-other-node"
  /** A literal internal address (db:5432) of a service on another node. */
  | "internal-address-other-node"
  /** Same as the two above, but the target has no exposed address to switch to. */
  | "service-not-exposed"
  /** The referenced variable exists but has no value yet (for example no domain yet). */
  | "empty-reference"
  /** Following the reference leads back to this variable (or into a loop), so it can never resolve. */
  | "reference-cycle"
  /**
   * Info: the value is another service's (or this one's) built-in address
   * written out (its URL, DOMAIN, INTERNAL_URL, ...), so a fix offers the
   * reference. Never names the value, only the key and the reference.
   */
  | "hardcoded-reference"
  /**
   * Warning: a ${{target.VARIABLE}} inside single quotes, which keep it as
   * text. The fix puts the value in double quotes, escaped to read the same.
   */
  | "single-quoted-reference"
  /**
   * Warning: target.VARIABLE written without ${{ }} in an unquoted or
   * double-quoted value, so the app gets the text. The fix wraps it, or
   * for an unknown target suggests close names. Names the token, never
   * the rest of the value.
   */
  | "bare-reference";

export type DiagnosticCode = SyntaxCode | ContextCode;

/** A text edit a quick fix applies. */
export interface TextEdit {
  range: SourceRange;
  text: string;
}

export type QuickFix =
  | { kind: "edit"; title: string; edits: TextEdit[] }
  /** Needs the panel: move this service to nodeId, or expose serviceId. */
  | { kind: "moveService"; title: string; nodeId: string; nodeName: string }
  | { kind: "exposeService"; title: string; serviceId: string; serviceName: string };

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  /** Short English line, for example "db runs on another node". */
  message: string;
  /** Longer English explanation for the hover, or empty. */
  detail: string;
  /** Values the message was built from, so a UI can render its own translated text per code. */
  params: Record<string, string>;
  range: SourceRange;
  fixes: QuickFix[];
}

export interface NodeRef {
  id: string;
  name: string;
}

/**
 * internal: only reachable on the project network of the same node.
 * public: reachable from anywhere (domain URL, exposed database port).
 * plain: not an address (user name, database name, a shared value).
 */
export type VariableScope = "internal" | "public" | "plain";

export interface ReferenceVariable {
  name: string;
  /** Resolved value for hovers and resolution; null when unknown or hidden from the caller. */
  value: string | null;
  scope: VariableScope;
  /** The value is a secret: UIs mask it until asked. */
  sensitive: boolean;
  /**
   * Builds and crash reports treat it as a secret (the panel's decision:
   * classifySecret with its references followed). Left out, sensitive
   * stands in for it.
   */
  secret?: boolean;
  /** Short English hint, for example "public URL". */
  description: string;
  /**
   * References written in this variable's own value (user variables of a
   * target), for cycle detection. Built-in variables leave it out.
   */
  dependsOn?: { target: string; variable: string }[];
}

/** Something a reference can point at: another service, or the project's shared variables. */
export interface ReferenceTarget {
  /** The reference prefix: the service name, or "project". */
  name: string;
  kind: "service" | "shared";
  serviceId: string | null;
  /** Service kind ("app", "postgres", ...); null for shared variables. */
  serviceKind: string | null;
  /** Nodes the target has instances on. Empty for shared variables. */
  nodes: NodeRef[];
  /** Host name services on the same node use (usually the service name); null for shared variables. */
  internalHost: string | null;
  /** Has a way in from other nodes (a live domain or an exposed port). */
  exposed: boolean;
  /** Built-in variables first (URL, INTERNAL_URL, EXPOSED_URL, ...), then the target's own keys. */
  variables: ReferenceVariable[];
}

/** Everything the analyzer needs about the world around one service's env. */
export interface AnalyzeContext {
  /**
   * The service whose env is being edited. builtins: its own built-in
   * values (DOMAIN, URL, INTERNAL_HOST, ...), which its env may reference
   * as \${{<its name>.DOMAIN}}: they depend on none of its variables. Its
   * own variables are not referenceable (they are the lines of the file).
   */
  self: { serviceId: string | null; name: string; nodes: NodeRef[]; builtins?: ReferenceVariable[] };
  /** Other services of the same project and the project's shared variables. */
  targets: ReferenceTarget[];
}

export interface AnalyzeResult {
  parsed: ParsedEnv;
  /** Syntax problems and context problems, sorted by position. */
  diagnostics: Diagnostic[];
}
