// Who is calling. Every op runs with exactly one principal; API keys and
// MCP tokens act as the person who created them, narrowed by their scope.

import type { Role } from "../db/schema";

export interface PrincipalUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export type Principal =
  | { type: "anonymous" }
  | { type: "session"; user: PrincipalUser; sessionId: string }
  | {
      type: "apiKey";
      user: PrincipalUser;
      keyId: string;
      keyName: string;
      /** "mcp" tokens are what model hosts use; destructive ops then need approval. */
      keyKind: "api" | "mcp";
      /** Actions the key may use; "*" for everything its owner may do. */
      actions: readonly string[];
      /** Null: every project the owner can reach; otherwise only these and their services. */
      projectIds: readonly string[] | null;
      readOnly: boolean;
    };

export const anonymous: Principal = { type: "anonymous" };

export function userOf(principal: Principal): PrincipalUser | undefined {
  return principal.type === "anonymous" ? undefined : principal.user;
}

/** For the audit log, for example "you@example.com via key ci". */
export function describePrincipal(principal: Principal): string {
  switch (principal.type) {
    case "anonymous":
      return "anonymous";
    case "session":
      return principal.user.email;
    case "apiKey":
      return `${principal.user.email} via ${principal.keyKind === "mcp" ? "MCP token" : "key"} ${principal.keyName}`;
  }
}
