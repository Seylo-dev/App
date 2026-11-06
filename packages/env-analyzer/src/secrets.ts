// Which variables are secrets. The runtime treats every value the same; the
// difference matters where a value can leak into something that is kept:
// a Nixpacks build bakes every variable it sees into the image (config and
// history in the registry), and agents strip secret values from crash
// reports and troubleshoot uploads. So a value is a secret when its name
// says so, when it looks like a credential, or when it references one; a
// "# @public" or "# @secret" comment on the line above (or after the value)
// overrides the guess for one variable.

import type { EnvEntry, EnvReference, ParsedEnv } from "./types";

/** Names that usually hold a secret ("STRIPE_SECRET_KEY", "DB_PASSWORD", "SENTRY_DSN"). */
const secretName = /SECRET|TOKEN|PASS|KEY|PRIVATE|CREDENTIAL|DSN/i;

/** A URL with a password in it: postgres://user:pass@host/db. */
const urlWithPassword = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i;

/** One long token of letters and digits (an API key or a generated password). */
const tokenLike = /^[A-Za-z0-9_\-+/=.]{24,}$/;

export function isSecretName(key: string): boolean {
  return secretName.test(key);
}

/** The value looks like a credential whatever its name. */
export function looksSecret(value: string): boolean {
  if (urlWithPassword.test(value)) return true;
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
 * Whether one entry is a secret: its override, else its name, its value, or
 * any reference `referenceIsSecret` says carries one (a database password,
 * another service's secret).
 */
export function isSecretEntry(
  parsed: Pick<ParsedEnv, "comments" | "text">,
  entry: EnvEntry,
  referenceIsSecret: (ref: EnvReference) => boolean = () => false,
): boolean {
  const override = secretOverride(parsed, entry);
  if (override) return override === "secret";
  if (isSecretName(entry.key) || looksSecret(entry.value)) return true;
  return entry.references.some(referenceIsSecret);
}
