// Which variables are secrets. The runtime treats every value the same; the
// difference matters where a value can leak into something that is kept:
// a Nixpacks build bakes every variable it sees into the image (config and
// history in the registry), a Dockerfile build gets secret variables only
// as BuildKit secret files (RUN --mount=type=secret,id=NAME), never as
// ARG NAME, and agents strip secret values from crash reports and
// troubleshoot uploads. So a value is a secret when its name says so, when
// it looks like a credential, or when it references one; a name with a
// framework's public prefix (publicPrefixes) is public whatever its name or
// a token-like value says, but not when it holds a password (a URL with
// one, or a reference to a database credential); the value of GIT_SHA, a
// commit id, never counts (publicNames); and a "# @public" or "# @secret"
// comment on the line above (or after the value) overrides all of that for
// one variable.

import { referenceValue } from "./builtins";
import { substituteReferences } from "./references";
import { findVariable } from "./resolve";
import type { AnalyzeContext, EnvEntry, EnvReference, ParsedEnv } from "./types";

/** Names that usually hold a secret ("STRIPE_SECRET_KEY", "DB_PASSWORD", "SENTRY_DSN"). */
const secretName = /SECRET|TOKEN|PASS|KEY|PRIVATE|CREDENTIAL|DSN/i;

/** A URL with a password in it: postgres://user:pass@host/db. */
const urlWithPassword = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i;

/** One long token of letters and digits (an API key or a generated password). */
const tokenLike = /^[A-Za-z0-9_\-+/=.]{24,}$/;

/**
 * Name prefixes of variables a framework ships to the browser: the build
 * inlines their values into the client bundle (or the page), so every
 * visitor can read them. A variable named with one is public by default:
 * calling it a secret protects nothing, and keeps it from the build that
 * needs it (a Dockerfile's ARG NAME stays empty, Nixpacks leaves it out).
 * Prefixes are case-sensitive, as the frameworks match them. "# @secret"
 * still makes one a secret, and so does a password in it (a URL with one,
 * or a reference to a database credential): PUBLIC_ is also a plain word
 * ("PUBLIC_DATABASE_URL", the outside address) in apps that are not
 * SvelteKit or Astro. The one list every check uses (isSecretName,
 * classifySecret, the web editor's masking).
 */
export const publicPrefixes: readonly { prefix: string; frameworks: string }[] = [
  { prefix: "NEXT_PUBLIC_", frameworks: "Next.js" },
  { prefix: "NUXT_PUBLIC_", frameworks: "Nuxt (runtimeConfig.public)" },
  { prefix: "EXPO_PUBLIC_", frameworks: "Expo" },
  { prefix: "REACT_APP_", frameworks: "Create React App" },
  { prefix: "VUE_APP_", frameworks: "Vue CLI" },
  { prefix: "GATSBY_", frameworks: "Gatsby" },
  { prefix: "VITE_", frameworks: "Vite" },
  { prefix: "PUBLIC_", frameworks: "SvelteKit, Astro" },
];

/** The framework public prefix the name starts with ("NEXT_PUBLIC_"), or null; the name must go on after it. */
export function publicPrefixOf(key: string): string | null {
  return publicPrefixes.find((p) => key.length > p.prefix.length && key.startsWith(p.prefix))?.prefix ?? null;
}

/** The name says secret (KEY, TOKEN, SECRET, ...) and has no framework public prefix. */
export function isSecretName(key: string): boolean {
  return publicPrefixOf(key) === null && secretName.test(key);
}

/** The value is a URL with a password in it (scheme://user:pass@host). */
function hasUrlPassword(value: string): boolean {
  return urlWithPassword.test(value);
}

/**
 * Names whose value is never a credential, whatever it looks like: GIT_SHA
 * holds a commit id (40 hex characters), which looksSecret takes for a
 * token, and a secret GIT_SHA reaches no Dockerfile build arg (ARG GIT_SHA)
 * and no Nixpacks build. A "# @secret" comment or a reference to a secret
 * still makes one a secret (classifySecret, reason "publicName").
 */
const publicNames = new Set(["GIT_SHA"]);

/** The name is one whose value never counts toward a secret (GIT_SHA). */
export function isPublicName(key: string): boolean {
  return publicNames.has(key);
}

/** The value looks like a credential whatever its name. */
export function looksSecret(value: string): boolean {
  if (hasUrlPassword(value)) return true;
  // A path or URL is long without being a key; a token mixes letters and digits.
  return tokenLike.test(value) && !value.includes("/") && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

export type SecretOverride = "public" | "secret";

/** A "# @public" or "# @secret" comment right above the entry or after its value. */
export function secretOverride(parsed: Pick<ParsedEnv, "comments" | "text">, entry: EnvEntry): SecretOverride | null {
  for (const comment of parsed.comments) {
    // A comment on its own line (not the previous entry's trailing one), directly above.
    const ownLine = parsed.text.slice(comment.range.start - (comment.range.startColumn - 1), comment.range.start).trim() === "";
    const above = ownLine && comment.range.endLine === entry.range.startLine - 1;
    const after = comment.range.startLine === entry.range.endLine && comment.range.start >= entry.range.end;
    if (!above && !after) continue;
    const word = comment.text.trim().split(/\s+/)[0]?.toLowerCase();
    if (word === "@public") return "public";
    if (word === "@secret") return "secret";
  }
  return null;
}

/**
 * Why a variable is or is not a secret: a "# @public"/"# @secret" comment,
 * a framework public prefix, a name whose value is never a credential
 * (publicName: GIT_SHA, a commit id), its name, its value (or the value
 * its references resolve to), a reference to a secret, or none of these.
 */
export type SecretReason = "comment" | "publicPrefix" | "publicName" | "name" | "value" | "reference" | "none";

export interface SecretVerdict {
  secret: boolean;
  reason: SecretReason;
  /** publicPrefix: the prefix ("NEXT_PUBLIC_"); publicName: the name; reference: the first secret one as target.VARIABLE. */
  detail?: string;
  /** Public by a comment, a prefix or a public name although its name or value alone would have made it a secret. */
  overridesGuess?: boolean;
  /**
   * A secret although its name has this framework public prefix: it holds a
   * password (reason value: a URL with one; reason reference: a reference
   * that carries a database credential).
   */
  publicPrefix?: string;
}

export interface ClassifyOptions {
  /** Whether a reference carries a secret (a database password, another service's secret); none do by default. */
  referenceIsSecret?: (ref: EnvReference) => boolean;
  /**
   * Whether a reference carries a database credential (a database's
   * PASSWORD or connection URL, or a variable that references one); none
   * do by default. Such a reference keeps a variable with a framework
   * public prefix a secret, which another secret does not.
   */
  referenceIsCredential?: (ref: EnvReference) => boolean;
  /** The value with its references resolved, null when they do not; asked only when nothing else decided. */
  resolvedValue?: () => string | null;
}

/** The guess from the name, the value as written and the value's references. */
function guess(entry: EnvEntry, options: ClassifyOptions): SecretVerdict {
  if (secretName.test(entry.key)) return { secret: true, reason: "name" };
  if (looksSecret(entry.value)) return { secret: true, reason: "value" };
  const ref = options.referenceIsSecret ? entry.references.find(options.referenceIsSecret) : undefined;
  if (ref) return { secret: true, reason: "reference", detail: `${ref.target}.${ref.variable}` };
  const resolved = options.resolvedValue?.();
  if (resolved && looksSecret(resolved)) return { secret: true, reason: "value" };
  return { secret: false, reason: "none" };
}

/**
 * A password under a framework public prefix: a URL with one as written, a
 * reference `referenceIsCredential` says carries a database credential, or
 * a resolved value that is a URL with a password. Null when there is none.
 */
function credentialUnderPrefix(entry: EnvEntry, prefix: string, options: ClassifyOptions): SecretVerdict | null {
  if (hasUrlPassword(entry.value)) return { secret: true, reason: "value", publicPrefix: prefix };
  const ref = options.referenceIsCredential ? entry.references.find(options.referenceIsCredential) : undefined;
  if (ref) return { secret: true, reason: "reference", detail: `${ref.target}.${ref.variable}`, publicPrefix: prefix };
  const resolved = entry.references.length > 0 ? options.resolvedValue?.() : null;
  if (resolved && hasUrlPassword(resolved)) return { secret: true, reason: "value", publicPrefix: prefix };
  return null;
}

/**
 * A name whose value never counts (isPublicName: GIT_SHA): public unless a
 * reference `referenceIsSecret` says carries a secret. The value, as
 * written or resolved, is not looked at, since a commit id looks like a
 * token to looksSecret.
 */
function publicByName(entry: EnvEntry, options: ClassifyOptions): SecretVerdict {
  const ref = options.referenceIsSecret ? entry.references.find(options.referenceIsSecret) : undefined;
  if (ref) return { secret: true, reason: "reference", detail: `${ref.target}.${ref.variable}` };
  return { secret: false, reason: "publicName", detail: entry.key, overridesGuess: looksSecret(entry.value) };
}

/**
 * Whether one entry is a secret, and why: its comment, else a framework
 * public prefix (public, unless it holds a password: a URL with one or a
 * reference `referenceIsCredential` says carries a database credential),
 * else a public name (GIT_SHA: public unless a reference carries a
 * secret), else its name, its value, a reference `referenceIsSecret` says
 * carries a secret, or its resolved value.
 */
export function classifySecret(parsed: Pick<ParsedEnv, "comments" | "text">, entry: EnvEntry, options: ClassifyOptions = {}): SecretVerdict {
  const override = secretOverride(parsed, entry);
  // Name and value as written only: cheap, and what makes a public one look like a secret.
  const looked = () => secretName.test(entry.key) || looksSecret(entry.value);
  if (override === "secret") return { secret: true, reason: "comment" };
  if (override === "public") return { secret: false, reason: "comment", overridesGuess: looked() };
  const prefix = publicPrefixOf(entry.key);
  if (prefix) {
    return credentialUnderPrefix(entry, prefix, options) ?? { secret: false, reason: "publicPrefix", detail: prefix, overridesGuess: looked() };
  }
  if (isPublicName(entry.key)) return publicByName(entry, options);
  return guess(entry, options);
}

/**
 * Whether one entry is a secret: its override, else a framework public
 * prefix (not a secret unless it holds a password: a URL with one, or a
 * reference `referenceIsCredential` says carries a database credential),
 * else its name, its value (unless the name is a public one,
 * isPublicName), or any reference `referenceIsSecret` says carries one (a
 * database password, another service's secret).
 */
export function isSecretEntry(
  parsed: Pick<ParsedEnv, "comments" | "text">,
  entry: EnvEntry,
  referenceIsSecret: (ref: EnvReference) => boolean = () => false,
  referenceIsCredential: (ref: EnvReference) => boolean = () => false,
): boolean {
  return classifySecret(parsed, entry, { referenceIsSecret, referenceIsCredential }).secret;
}

/**
 * Whether target.name carries a database credential in the analyzer
 * context: a built-in variable (no dependsOn) of a service that is a
 * secret (the sensitive ones are a database's PASSWORD and connection
 * URLs), or a service's own variable whose references (dependsOn) lead to
 * one. Shared variables hold no references; a URL with a password in one
 * shows in the resolved value.
 */
function carriesCredential(context: AnalyzeContext, target: string, name: string, seen: Set<string>): boolean {
  const found = findVariable(context, target, name);
  if (!found || found.target.kind !== "service") return false;
  const v = found.variable;
  if (v.dependsOn === undefined) return v.secret ?? v.sensitive;
  const id = `${found.target.name.toLowerCase()}.${v.name}`;
  if (seen.has(id)) return false;
  seen.add(id);
  return v.dependsOn.some((d) => carriesCredential(context, d.target, d.variable, seen));
}

/**
 * classifySecret for every entry of a service's env with what the panel
 * sent in the analyzer context (env.references): a referenced variable is
 * a secret by its `secret` flag (the panel's own decision), else by
 * `sensitive`, a reference carries a database credential as
 * carriesCredential says, and the resolved value uses the context's
 * values (for ${{api.DOMAINS[1]}} that item, as referenceValue gives it).
 * So the editor shows, for unsaved text, what builds and crash reports
 * will do.
 */
export function classifyEntries(parsed: ParsedEnv, context: AnalyzeContext): SecretVerdict[] {
  const variable = (target: string, name: string) => findVariable(context, target, name)?.variable ?? null;
  return parsed.entries.map((entry) =>
    classifySecret(parsed, entry, {
      referenceIsSecret: (ref) => {
        const v = variable(ref.target, ref.variable);
        return v ? (v.secret ?? v.sensitive) : false;
      },
      referenceIsCredential: (ref) => carriesCredential(context, ref.target, ref.variable, new Set()),
      resolvedValue: () => {
        if (entry.quote === "single") return entry.value;
        // With an index (${{api.DOMAINS[1]}}) the item, like resolveEnv and the panel: not the whole list.
        const out = substituteReferences(entry.value, (target, name, index) => referenceValue(variable(target, name), index));
        return out.unresolved.length > 0 ? null : out.value;
      },
    }),
  );
}
