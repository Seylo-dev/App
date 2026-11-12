// A service's .env text and the project's shared variables, plus what the
// editor needs around them: the References list with resolved values for
// hovers, and diagnostics from @seylo/env-analyzer. The schemas below
// mirror that package's types (SourceRange, Diagnostic, AnalyzeContext), so
// the editor passes env.references output straight to analyzeEnv().

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";

/** Longest .env text the ops take and return, in UTF-16 code units (what maxLength counts); 256 KiB is far above any real file. */
export const envTextMaxLength = 262144;

/** .env text as people edit it. */
export const EnvText = Type.String({ maxLength: envTextMaxLength, description: "Contents of a .env file." });

export const SourceRange = Type.Object({
  start: Type.Integer({ minimum: 0 }),
  end: Type.Integer({ minimum: 0 }),
  startLine: Type.Integer({ minimum: 1 }),
  startColumn: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  endColumn: Type.Integer({ minimum: 1 }),
});

export const Severity = Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info"), Type.Literal("hint")]);

export const DiagnosticCode = Type.Union(
  [
    "invalid-line",
    "invalid-key",
    "missing-equals",
    "unterminated-quote",
    "trailing-characters",
    "unterminated-reference",
    "malformed-reference",
    "duplicate-key",
    "unknown-service",
    "unknown-variable",
    "self-reference",
    "internal-reference-other-node",
    "internal-address-other-node",
    "service-not-exposed",
    "empty-reference",
    "reference-cycle",
    "hardcoded-reference",
  ].map((code) => Type.Literal(code)),
);

export const QuickFix = Type.Union([
  Type.Object({
    kind: Type.Literal("edit"),
    title: Type.String(),
    edits: Type.Array(Type.Object({ range: SourceRange, text: Type.String() })),
  }),
  Type.Object({ kind: Type.Literal("moveService"), title: Type.String(), nodeId: Type.String(), nodeName: Type.String() }),
  Type.Object({ kind: Type.Literal("exposeService"), title: Type.String(), serviceId: Type.String(), serviceName: Type.String() }),
]);

export const Diagnostic = Type.Object({
  code: DiagnosticCode,
  severity: Severity,
  message: Type.String(),
  detail: Type.String(),
  params: Type.Record(Type.String(), Type.String()),
  range: SourceRange,
  fixes: Type.Array(QuickFix),
});

export const NodeRef = Type.Object({ id: Type.String(), name: Type.String() });

export const VariableScope = Type.Union([Type.Literal("internal"), Type.Literal("public"), Type.Literal("plain")]);

export const ReferenceVariable = Type.Object({
  name: Type.String(),
  /** Resolved value; null when unknown or hidden from the caller. */
  value: Type.Union([Type.String(), Type.Null()]),
  scope: VariableScope,
  /** The value is a secret: UIs mask it until asked. */
  sensitive: Type.Boolean(),
  /**
   * Builds and crash reports treat it as a secret (a Dockerfile build gets it only as a BuildKit secret, not as ARG):
   * its "# @public"/"# @secret" comment, a framework public prefix such as NEXT_PUBLIC_ (public unless it holds a
   * password), its name, value or references. Left out on built-in variables, where sensitive says it.
   */
  secret: Type.Optional(Type.Boolean()),
  description: Type.String(),
  /** References written in this variable's own value, for cycle detection. Built-in variables leave it out. */
  dependsOn: Type.Optional(Type.Array(Type.Object({ target: Type.String(), variable: Type.String() }))),
});

export const ReferenceTarget = Type.Object({
  /** Reference prefix: the service name, or "project" for shared variables. */
  name: Type.String(),
  kind: Type.Union([Type.Literal("service"), Type.Literal("shared")]),
  serviceId: Type.Union([Id, Type.Null()]),
  serviceKind: Type.Union([Type.String(), Type.Null()]),
  nodes: Type.Array(NodeRef),
  internalHost: Type.Union([Type.String(), Type.Null()]),
  exposed: Type.Boolean(),
  variables: Type.Array(ReferenceVariable),
});

/** Same shape as AnalyzeContext in @seylo/env-analyzer. */
export const AnalyzeContext = Type.Object({
  self: Type.Object({
    serviceId: Type.Union([Id, Type.Null()]),
    name: Type.String(),
    nodes: Type.Array(NodeRef),
    /** The service's own built-in values (DOMAIN, URL, INTERNAL_HOST, ...), which its env may reference by its own name. */
    builtins: Type.Optional(Type.Array(ReferenceVariable)),
  }),
  targets: Type.Array(ReferenceTarget),
});

/** A variable name as the .env parser takes it. */
export const EnvKey = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z_][A-Za-z0-9_.-]*$",
  description: "Variable name: a letter or _, then letters, digits, _, . or -.",
});

/** One variable's new value; null removes the variable. */
export const EnvValue = Type.Union([Type.String({ maxLength: envTextMaxLength }), Type.Null()], {
  description: "The new value as the program should read it, without quotes (references allowed). null removes the variable.",
});

export const EnvVariable = Type.Object({
  key: Type.String(),
  value: Type.String(),
  /** Line of the key in text, 1-based. */
  line: Type.Integer({ minimum: 1 }),
});

const serviceScope = (action: `${string}.${string}`) => permission.service(action, (input: { serviceId: string }) => input.serviceId);
const projectScope = (action: `${string}.${string}`) => permission.project(action, (input: { projectId: string }) => input.projectId);

export const get = defineOp({
  id: "env.get",
  kind: "query",
  summary: "Get a service's environment",
  description:
    "Returns the service's .env text as saved, the parsed variables (references left as written) and how many shared project variables it also receives. Model callers (MCP, the assistant) get every value redacted: to change one variable without the others, use env.setVariable.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    text: EnvText,
    variables: Type.Array(EnvVariable),
    /** Shared variables from the project ("+ 3 shared variables from acme-shop"). */
    sharedCount: Type.Integer({ minimum: 0 }),
    /** Null when the env was never saved. Pass it back to env.set to avoid overwriting someone else's save. */
    updatedAt: Type.Union([Timestamp, Type.Null()]),
  }),
  sensitive: { output: ["text", "variables.*.value"] },
  permission: serviceScope("env.view"),
  mcp: true,
  audit: false,
});

export const set = defineOp({
  id: "env.set",
  kind: "mutation",
  summary: "Save a service's environment",
  description:
    "Replaces the service's whole .env text. Syntax errors are refused; context problems (for example an internal address of a service on another node) are saved and returned as diagnostics. The new values apply on the next deploy or restart. To change one variable and keep the others as they are, use env.setVariable.",
  input: Type.Object({
    serviceId: Id,
    text: EnvText,
    /** updatedAt from env.get; refused with CONFLICT when someone saved in between. Leave out to overwrite. */
    expectedUpdatedAt: Type.Optional(Type.Union([Timestamp, Type.Null()])),
  }),
  output: Type.Object({
    updatedAt: Timestamp,
    diagnostics: Type.Array(Diagnostic),
    /** True when running instances still have the old values. */
    restartNeeded: Type.Boolean(),
  }),
  sensitive: { input: ["text"] },
  permission: serviceScope("env.edit"),
  mcp: true,
  audit: true,
});

export const setVariable = defineOp({
  id: "env.setVariable",
  kind: "mutation",
  summary: "Set one variable of a service's environment",
  description:
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${{svc.VAR}} is the reference syntax, not a template
    "Sets one variable and keeps the rest of the .env text as it is, so a caller that cannot read the other values (model callers get env.get redacted) changes only this line. An existing key keeps its line: the value of the last line with that key (the one that wins) is replaced, in its quote style when the value fits it, with its export, its trailing comment and the comment lines above it (# @public stays). A new key is appended as KEY=value. value null removes every line with the key (NOT_FOUND when there is none). Give the value unquoted; ${{target.VARIABLE}} references are allowed, and a value with spaces or a newline is written in double quotes. Same checks as env.set, and refused when the text would grow past 262144 characters; the diagnostics of the whole file come back (hardcoded-reference: a value that spells out a service's URL, with a fix to its reference). The new value applies on the next deploy or restart.",
  input: Type.Object({
    serviceId: Id,
    key: EnvKey,
    value: EnvValue,
    /** updatedAt from env.get; refused with CONFLICT when someone saved in between. Leave out to edit whatever is saved now. */
    expectedUpdatedAt: Type.Optional(Type.Union([Timestamp, Type.Null()])),
  }),
  output: Type.Object({
    updatedAt: Timestamp,
    diagnostics: Type.Array(Diagnostic),
    /** True when running instances still have the old values. */
    restartNeeded: Type.Boolean(),
  }),
  sensitive: { input: ["value"] },
  permission: serviceScope("env.edit"),
  mcp: true,
  audit: true,
});

export const references = defineOp({
  id: "env.references",
  kind: "query",
  summary: "List what a service can reference",
  description:
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${{svc.VAR}} is the reference syntax, not a template
    "Returns every ${{target.VARIABLE}} the service can use: other services of the project with their built-in variables (URL, INTERNAL_URL, EXPOSED_URL, ...) and the project's shared variables, with resolved values for hovers and the nodes each target runs on. The result is the analyzer context for @seylo/env-analyzer.",
  input: Type.Object({ serviceId: Id }),
  output: AnalyzeContext,
  sensitive: { output: ["targets.*.variables.*.value"] },
  permission: serviceScope("env.view"),
  mcp: true,
  audit: false,
});

export const analyze = defineOp({
  id: "env.analyze",
  kind: "query",
  summary: "Check a service's environment",
  description:
    "Runs the env analyzer over the saved .env of a service and returns its diagnostics: syntax errors, unknown references, and internal addresses of services on another node (there is no cross-node private network). The web editor runs the same analyzer locally on unsaved text.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({ diagnostics: Type.Array(Diagnostic) }),
  permission: serviceScope("env.view"),
  mcp: true,
  audit: false,
});

export const getShared = defineOp({
  id: "env.getShared",
  kind: "query",
  summary: "Get a project's shared variables",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${{svc.VAR}} is the reference syntax, not a template
  description: "Returns the project's shared variables as .env text. Every service of the project can use them as ${{project.NAME}}.",
  input: Type.Object({ projectId: Id }),
  output: Type.Object({
    text: EnvText,
    variables: Type.Array(EnvVariable),
    updatedAt: Type.Union([Timestamp, Type.Null()]),
  }),
  sensitive: { output: ["text", "variables.*.value"] },
  permission: projectScope("env.view"),
  mcp: true,
  audit: false,
});

export const setShared = defineOp({
  id: "env.setShared",
  kind: "mutation",
  summary: "Save a project's shared variables",
  description:
    "Replaces the project's shared variables (.env text). Shared variables cannot reference services. Services that use them get the new values on their next deploy or restart.",
  input: Type.Object({
    projectId: Id,
    text: EnvText,
    expectedUpdatedAt: Type.Optional(Type.Union([Timestamp, Type.Null()])),
  }),
  output: Type.Object({
    updatedAt: Timestamp,
    diagnostics: Type.Array(Diagnostic),
    /** Services that reference a changed variable and still run with the old value. */
    affectedServiceIds: Type.Array(Id),
  }),
  sensitive: { input: ["text"] },
  permission: projectScope("env.edit"),
  mcp: true,
  audit: true,
});

export const setSharedVariable = defineOp({
  id: "env.setSharedVariable",
  kind: "mutation",
  summary: "Set one of a project's shared variables",
  description:
    "Sets one shared variable and keeps the others as they are, like env.setVariable for a service: the last line with the key gets the new value (its quoting, comments and # @public kept), a new key is appended, value null removes every line with the key (NOT_FOUND when there is none). Refused when the text would grow past 262144 characters. Shared variables cannot reference services. Services that use them get the new value on their next deploy or restart.",
  input: Type.Object({
    projectId: Id,
    key: EnvKey,
    value: EnvValue,
    expectedUpdatedAt: Type.Optional(Type.Union([Timestamp, Type.Null()])),
  }),
  output: Type.Object({
    updatedAt: Timestamp,
    diagnostics: Type.Array(Diagnostic),
    /** Services that reference or receive the changed variable and still run with the old value. */
    affectedServiceIds: Type.Array(Id),
  }),
  sensitive: { input: ["value"] },
  permission: projectScope("env.edit"),
  mcp: true,
  audit: true,
});
