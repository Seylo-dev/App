// Schemas shared by several op modules. Module-specific shapes stay in
// their own file under src/ops/.

import { Type } from "@sinclair/typebox";

/** Panel-issued id: lowercase letters and digits, safe in paths and Docker names. */
export const Id = Type.String({ pattern: "^[a-z0-9]{16}$", description: "Panel-issued id." });

/** RFC 3339 timestamp in UTC. Ops return strings, never Date objects. */
export const Timestamp = Type.String({ format: "date-time" });

/** An empty object, for ops that take no input or return nothing. */
export const Empty = Type.Object({});

/**
 * A git remote: https://, ssh:// or git@host:path. No user name or token in
 * an https URL and no password in an ssh URL (ssh://git@host is fine): a
 * token there would be stored in the service spec and the audit log and
 * shown to everyone who can view the service. Tokens go in git credentials.
 */
export const GitUrl = Type.String({
  minLength: 1,
  maxLength: 500,
  pattern: "^(https://[^/@\\s]+(/\\S*)?|ssh://([^/:@\\s]+@)?[^/@\\s]+(/\\S*)?|git@\\S+)$",
  description: "https://, ssh:// or git@host:path URL, without a token or password in it (use a git credential).",
  errorMessage: "put no user name, token or password in a git URL; store it as a git credential and pick that instead",
});
