// @seylo/env-analyzer: .env parsing with source ranges, ${{service.VAR}}
// references (${{service.LIST[n]}} for one item of a list variable such as
// DOMAINS), resolution and diagnostics. Pure functions with no
// dependencies, so the web editor, the panel and the MCP server run the
// same code and agree on every underline.
//
//   const { parsed, diagnostics } = analyzeEnv(text, context); // context from the env.references op
//   const { values } = resolveEnv(parsed, context);

export { analyzeEnv, analyzeParsed, pickPublicVariable } from "./analyze";
export {
  appVariables,
  type BuiltinVariable,
  builtinVariablesFor,
  clickhouseVariables,
  databaseVariables,
  listItemName,
  listItems,
  listNames,
  referenceValue,
} from "./builtins";
export { type EnvEdit, setEnvVariable } from "./edit";
export { browserPrefixes, isBrowserVariable } from "./hardcoded";
export { type HostMention, hostMentions } from "./hosts";
export { missingNodes } from "./nodes";
export { isValidKey, parseEnv, stringifyEnv } from "./parse";
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
  isPublicName,
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
