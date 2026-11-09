// What a git credential for a repository URL looks like: its host, read the
// way the panel reads it (urlHost in apps/panel/src/modules/git/remote.ts,
// since the panel sends a credential to its own host only and refuses any
// other), the kind the URL needs, a default name, and which provider's
// wording to use for tokens and deploy keys.

import { git } from "@seylo/ops";

export type CredentialKind = "token" | "ssh_key";
export type GitHostProvider = "github" | "gitlab" | "bitbucket" | "other";

const scpUrl = /^([^@/\s]+)@([^:/\s]+):(.+)$/;
const hostPattern = new RegExp(git.GitHost.pattern as string);

/** git@host:path or ssh://... (the panel's parseSshUrl). */
export function isSshUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed.startsWith("ssh://") || scpUrl.test(trimmed);
}

/**
 * host[:port] of a git URL, lower case, as the panel records it: an SSH port
 * other than 22 and an https:// port other than 443 stay. Null when it is no git URL.
 */
export function credentialHost(url: string): string | null {
  const trimmed = url.trim();
  const scp = scpUrl.exec(trimmed);
  if (scp && !trimmed.startsWith("ssh://")) return (scp[2] as string).toLowerCase();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "ssh:") {
      if (!parsed.hostname) return null;
      const port = parsed.port && parsed.port !== "22" ? `:${parsed.port}` : "";
      return `${parsed.hostname.toLowerCase()}${port}`;
    }
    if (parsed.protocol === "https:") return parsed.host.toLowerCase() || null;
    return null;
  } catch {
    return null;
  }
}

/** Whether git.createCredential and git.generateSshKey take this host (GitHost). */
export function validHost(host: string): boolean {
  return hostPattern.test(host);
}

/** SSH URLs need a key, https:// URLs a token. */
export function kindForUrl(url: string): CredentialKind {
  return isSshUrl(url) ? "ssh_key" : "token";
}

/** "acme/shop-api" for a repository URL: a default name for its credential (at most 60 characters). */
export function repoLabel(url: string): string {
  const trimmed = url.trim();
  const scp = scpUrl.exec(trimmed);
  let path = "";
  if (scp && !trimmed.startsWith("ssh://")) path = scp[3] as string;
  else {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      path = "";
    }
  }
  const parts = path
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter(Boolean);
  return parts.slice(-2).join("/").slice(0, 60);
}

/** Whose wording the token and deploy key hints use. */
export function providerOf(host: string): GitHostProvider {
  const name = host.replace(/:\d+$/, "");
  if (name === "github.com") return "github";
  if (name === "gitlab.com" || name.startsWith("gitlab.")) return "gitlab";
  if (name === "bitbucket.org") return "bitbucket";
  return "other";
}

/** The panel trusts GitHub's SSH host keys by itself (builtinKnownHosts); every other host needs known_hosts lines. */
export function needsKnownHosts(host: string): boolean {
  return host !== "github.com";
}

/** An OpenSSH or PEM private key, as git.createCredential takes it. */
export function looksLikePrivateKey(text: string): boolean {
  return /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text.trim());
}
