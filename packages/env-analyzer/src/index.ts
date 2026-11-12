// @seylo/env-analyzer: .env parsing with source ranges, ${{service.VAR}}
// references, resolution and diagnostics. Pure functions with no
// dependencies, so the web editor, the panel and the MCP server run the
// same code and agree on every underline.
//
//   const { parsed, diagnostics } = analyzeEnv(text, context); // context from the env.references op
//   const { values } = resolveEnv(parsed, context);

export { analyzeEnv, analyzeParsed, missingNodes, pickPublicVariable } from "./analyze";
export { appVariables, type BuiltinVariable, builtinVariablesFor, clickhouseVariables, databaseVariables } from "./builtins";
export { type HostMention, hostMentions } from "./hosts";
export { parseEnv, stringifyEnv } from "./parse";
export { formatReference, referenceAt, scanReferences, sharedTarget, substituteReferences } from "./references";
export {
  describeReference,
  findVariable,
  type ReferenceCompletion,
  type ReferenceHover,
  type ResolvedEnv,
  referenceCompletions,
  resolveEnv,
} from "./resolve";
export {
  type ClassifyOptions,
  classifyEntries,
  classifySecret,
  isSecretEntry,
  isSecretName,
  looksSecret,
  publicPrefixes,
  publicPrefixOf,
  type SecretOverride,
  type SecretReason,
  type SecretVerdict,
  secretOverride,
} from "./secrets";
export { LineIndex, rangeContains } from "./source";
export type * from "./types";
