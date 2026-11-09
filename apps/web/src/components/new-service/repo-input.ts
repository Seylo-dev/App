// What the New app dialog's Repository field accepts, read without asking
// the panel: a full git URL (https://, ssh://, git@host:path), "owner/repo"
// for GitHub, or a host and path without a scheme ("github.com/acme/app",
// "gitlab.com/group/sub/app", "git.example.com:3000/team/app"), each with or
// without .git. A page address of a well-known host (github.com/acme/app/tree/dev)
// gives the repository and the branch in it.

import { GitUrl } from "@seylo/ops";

export interface RepoRef {
  /** What a plain git source clones: a full URL as written, https://<host>/<path> for a short form. */
  url: string;
  /** host[:port], lower case: "github.com", "git.example.com:3000". */
  host: string;
  /** The repository's path at the host, without .git or slashes at the ends: "acme/app", "group/sub/app". */
  path: string;
  /** Cloned over SSH (ssh:// or git@host:path): it needs a deploy key. */
  ssh: boolean;
  /** A branch the address names (".../tree/dev"); null otherwise. */
  branch: string | null;
}

/**
 * Why the text is no repository: nothing typed, a token or password in it,
 * plain http (the panel clones over https or ssh only), a path of more than
 * owner/repo without a host, or anything else.
 */
export type RepoProblem = "empty" | "credentials" | "insecure" | "needsHost" | "invalid";

export type RepoParse = { ok: true; repo: RepoRef } | { ok: false; problem: RepoProblem };

/** Hosts whose repositories always clone as https://<host>/<owner>/<name>.git. */
const wellKnown = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"]);

/** The panel's own rule for a git URL (no user name or token in an https:// one). */
const gitUrl = new RegExp(GitUrl.pattern as string);

const hostName = /^(?:localhost|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)(?::\d{1,5})?$/;
const pathSegment = /^[A-Za-z0-9_.~-]+$/;
const githubOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const githubName = /^[A-Za-z0-9_.-]+$/;

const fail = (problem: RepoProblem): RepoParse => ({ ok: false, problem });

/** "acme/app.git/" -> "acme/app". */
function trimPath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

/** A path made of real segments: no empty ones, no "." or "..". */
function cleanSegments(path: string): string[] | null {
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || !pathSegment.test(part))) return null;
  return parts;
}

/**
 * The repository and the branch in a page address of a well-known host:
 * github.com/acme/app/tree/dev, gitlab.com/group/app/-/tree/dev,
 * bitbucket.org/acme/app/src/dev, codeberg.org/acme/app/src/branch/dev.
 */
function wellKnownRepo(host: string, parts: string[]): { path: string; branch: string | null } | null {
  if (host === "gitlab.com") {
    const dash = parts.indexOf("-");
    const repo = dash === -1 ? parts : parts.slice(0, dash);
    if (repo.length < 2) return null;
    const rest = dash === -1 ? [] : parts.slice(dash + 1);
    const branch = rest[0] === "tree" && rest.length > 1 ? rest.slice(1).join("/") : null;
    return { path: repo.map((p) => p.replace(/\.git$/i, "")).join("/"), branch };
  }
  const [owner, name, ...rest] = parts;
  if (!owner || !name) return null;
  let branch: string | null = null;
  if (host === "github.com" && rest[0] === "tree" && rest.length > 1) branch = rest.slice(1).join("/");
  if (host === "bitbucket.org" && rest[0] === "src" && rest[1]) branch = rest[1];
  if (host === "codeberg.org" && rest[0] === "src" && rest[1] === "branch" && rest.length > 2) branch = rest.slice(2).join("/");
  return { path: `${owner}/${name.replace(/\.git$/i, "")}`, branch };
}

/** A repository on an https host: well-known hosts get their canonical clone URL. */
function httpsRepo(host: string, rawPath: string, typedUrl: string | null): RepoParse {
  const lower = host.toLowerCase();
  // A short form names plain segments ("team//app" is a typo, not a path).
  if (typedUrl === null && !cleanSegments(trimPath(rawPath))) return fail("invalid");
  const parts = trimPath(rawPath).split("/").filter(Boolean);
  if (wellKnown.has(lower)) {
    const found = wellKnownRepo(lower, parts);
    if (!found || !cleanSegments(found.path)) return fail("invalid");
    return finish({ url: `https://${lower}/${found.path}.git`, host: lower, path: found.path, ssh: false, branch: found.branch });
  }
  // A full URL keeps any path the host serves (percent escapes, "_git/app").
  const path = parts.join("/");
  if (path === "") return fail("invalid");
  const url = typedUrl ?? `https://${lower}/${rawPath.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  return finish({ url, host: lower, path, ssh: false, branch: null });
}

function finish(repo: RepoRef): RepoParse {
  return gitUrl.test(repo.url) ? { ok: true, repo } : fail("invalid");
}

export function parseRepoInput(input: string): RepoParse {
  const text = input.trim();
  if (text === "") return fail("empty");
  if (/\s/.test(text)) return fail("invalid");

  if (/^http:\/\//i.test(text)) return fail("insecure");

  if (/^https:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return fail("invalid");
    }
    if (url.username || url.password) return fail("credentials");
    const typed = text.replace(/[?#].*$/, "").replace(/\/+$/, "");
    return httpsRepo(url.host, url.pathname, typed);
  }

  if (/^ssh:\/\//i.test(text)) {
    if (/^ssh:\/\/[^/@]*:[^/@]*@/i.test(text)) return fail("credentials");
    const match = /^ssh:\/\/(?:[^/:@]+@)?([^/@]+)(\/.*)?$/i.exec(text);
    const host = match?.[1]?.toLowerCase();
    const path = trimPath(match?.[2] ?? "");
    if (!host || !hostName.test(host) || path === "" || !cleanSegments(path)) return fail("invalid");
    return finish({ url: text, host, path, ssh: true, branch: null });
  }

  if (/^git@/i.test(text)) {
    const match = /^git@([^:/]+):(.+)$/i.exec(text);
    const host = match?.[1]?.toLowerCase();
    const path = trimPath(match?.[2] ?? "");
    if (!host || !hostName.test(host) || path === "" || !cleanSegments(path)) return fail("invalid");
    return finish({ url: text, host, path, ssh: true, branch: null });
  }

  // Any other scheme ("ftp://", "file://"), or a user before a host ("token@github.com/acme/app").
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return fail("invalid");
  // user@host:path with a user other than git: the panel stores git@ ones only.
  if (/^[^@/:]+@[^@/:]+:/.test(text)) return fail("invalid");
  if (text.includes("@")) return fail("credentials");

  const [first = "", ...rest] = text.replace(/\/+$/, "").split("/");
  const isHost = first.includes(".") || first.includes(":") || first.toLowerCase() === "localhost";
  if (isHost) {
    if (!hostName.test(first) || rest.length === 0) return fail("invalid");
    return httpsRepo(first, rest.join("/"), null);
  }

  // owner/repo: a GitHub repository.
  if (rest.length === 1) {
    const name = (rest[0] ?? "").replace(/\.git$/i, "");
    if (!githubOwner.test(first) || !githubName.test(name) || name === "." || name === "..") return fail("invalid");
    const path = `${first}/${name}`;
    return finish({ url: `https://github.com/${path}.git`, host: "github.com", path, ssh: false, branch: null });
  }
  return rest.length > 1 && cleanSegments(text.replace(/\/+$/, "")) ? fail("needsHost") : fail("invalid");
}
