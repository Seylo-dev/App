// Git URLs never carry a token: the GitUrl schema (@seylo/ops) refuses a
// user name or token in https:// URLs and a password in ssh:// URLs, and
// git credentials hold the secret. Sources saved before that rule may still
// have one, so every answer that shows a source drops it.

const httpsUserinfo = /^https:\/\/[^/@]*@/;
const sshPassword = /^ssh:\/\/([^/@]*?)(:[^/@]*)?@/;

/** The URL without a user name or token (https) or password (ssh); ssh://git@host stays. */
export function withoutCredentials(url: string): string {
  return url.replace(httpsUserinfo, "https://").replace(sshPassword, (_match, user: string) => (user ? `ssh://${user}@` : "ssh://"));
}

/** A source (service or compose) as shown to people, models and the audit log. */
export function displaySource<T extends { type: string }>(source: T): T {
  if (!("url" in source) || typeof source.url !== "string") return source;
  return { ...source, url: withoutCredentials(source.url) };
}
