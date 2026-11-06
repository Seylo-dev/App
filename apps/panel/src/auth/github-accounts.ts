// Linked GitHub logins. One per person; the token is sealed and may later
// clone private repos when the person granted the repo scope.

import { eq } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { githubAccounts } from "../db/schema";
import type { SecretBox } from "../security/secret-box";
import type { GithubUser } from "./github-device";

export function githubAccountFor(db: PanelDb, githubUserId: number) {
  return db.select().from(githubAccounts).where(eq(githubAccounts.githubUserId, githubUserId)).get();
}

/**
 * Links `github` to the person, replacing an older link. On sign-in the
 * fresh token only replaces the stored one when it has at least the same
 * scopes, so signing in never drops repo access granted earlier.
 */
export function saveGithubAccount(
  db: PanelDb,
  secrets: SecretBox,
  userId: string,
  github: GithubUser,
  token: string,
  scopes: string[],
  options: { keepBroaderToken?: boolean } = {},
): void {
  const existing = db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId)).get();
  if (existing && existing.githubUserId === github.id) {
    const narrower = options.keepBroaderToken && existing.scopes.some((scope) => !scopes.includes(scope));
    db.update(githubAccounts)
      .set(narrower ? { login: github.login } : { login: github.login, accessTokenSealed: secrets.seal(token, "github.account"), scopes })
      .where(eq(githubAccounts.id, existing.id))
      .run();
    return;
  }
  db.transaction((tx) => {
    tx.delete(githubAccounts).where(eq(githubAccounts.userId, userId)).run();
    tx.insert(githubAccounts)
      .values({ userId, githubUserId: github.id, login: github.login, accessTokenSealed: secrets.seal(token, "github.account"), scopes })
      .run();
  });
}
