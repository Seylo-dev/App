// What the New app dialog's repository fields accept, read without asking
// the panel: a full git URL (https://, ssh://, git@host:path), "owner/repo"
// for GitHub (the GitHub tab only; the Git repository tab wants the host),
// or a host and path without a scheme ("github.com/acme/app",
// "gitlab.com/group/sub/app", "git.example.com:3000/team/app"), each with or
// without .git. A page address of a host whose kind is known (github.com,
// gitlab.com, bitbucket.org, codeberg.org, and the servers of the person's
// GitLab and Gitea connections) gives the repository, plus what the address
// names after tree/ or src/: the branch, maybe followed by a folder.
// branchFromRef tells the branch from the folder once the branches are known.

import { GitUrl } from "@seylo/ops";

/** The kinds of git server whose page addresses the parser knows. */
export type HostKind = "github" | "gitlab" | "gitea" | "bitbucket";

/** A server whose page addresses the parser reads by its kind. */
export interface KnownHost {
  /** host[:port], lower case. */
  host: string;
  kind: HostKind;
  /** The path the server lives under ("gitlab" for https://example.com/gitlab), "" at the root. */
  prefix: string;
}

export interface RepoRef {
  /** What a plain git source clones: a full URL as written, https://<host>/<path>(.git) for a short form or a page address. */
  url: string;
  /** host[:port], lower case: "github.com", "git.example.com:3000". */
  host: string;
  /** The repository's path at the host, without .git or slashes at the ends: "acme/app", "group/sub/app". */
  path: string;
  /** Cloned over SSH (ssh:// or git@host:path): it needs a deploy key. */
  ssh: boolean;
  /**
   * What a page address names after tree/ (src/branch/, src/): the branch,
   * maybe followed by a folder or a file ("main", "apps", "web"). null for
   * an address of the repository itself.
   */
  ref: string[] | null;
}

/**
 * Why the text is no repository: nothing typed, a token or password in it,
 * plain http (the panel clones over https or ssh only), a path of more than
 * owner/repo without a host, owner/repo where only a full address is taken
 * (the Git repository tab), a repository on another host than github.com
 * (the GitHub tab), or anything else.
 */
export type RepoProblem = "empty" | "credentials" | "insecure" | "needsHost" | "shorthand" | "notGithub" | "invalid";

export type RepoParse = { ok: true; repo: RepoRef } | { ok: false; problem: RepoProblem };

/** Hosts whose kind is known without a connection; their repositories clone as https://<host>/<path>.git. */
const wellKnown: KnownHost[] = [
  { host: "github.com", kind: "github", prefix: "" },
  { host: "gitlab.com", kind: "gitlab", prefix: "" },
  { host: "bitbucket.org", kind: "bitbucket", prefix: "" },
  { host: "codeberg.org", kind: "gitea", prefix: "" },
];

/**
 * Words that end a GitLab project path in an older page address without
 * "/-/" (gitlab.com/acme/app/tree/main): GitLab reserves them as project
 * names, so they never are one.
 */
const gitlabRoutes = new Set(["-", "tree", "blob", "commits", "commit", "merge_requests", "raw", "blame"]);

/** The panel's own rule for a git URL (no user name or token in an https:// one). */
const gitUrl = new RegExp(GitUrl.pattern as string);

const hostName = /^(?:localhost|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)(?::\d{1,5})?$/;
const pathSegment = /^[A-Za-z0-9_.~-]+$/;
const githubOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const githubName = /^[A-Za-z0-9_.-]+$/;
/** A commit id as page addresses show it (src/3f2a9c1/...): not a branch. */
const commitLike = /^[0-9a-f]{7,40}$/i;

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

const withoutGit = (segment: string) => segment.replace(/\.git$/i, "");

/** The rest of a page address after its branch marker, or null when it names none. */
const refAfter = (rest: string[], from: number): string[] | null => (rest.length > from ? rest.slice(from) : null);

/**
 * The repository and what the page names, by the server's kind, from the
 * segments after the server's prefix:
 *   github     owner/name/tree/<ref>
 *   gitlab     group/sub/project/-/tree/<ref>, or group/project/tree/<ref> without "-"
 *   gitea      owner/name/src/branch/<ref> (Forgejo and Codeberg too)
 *   bitbucket  workspace/slug/src/<ref>, workspace/slug/branch/<ref>
 * null when the segments name no repository (one segment).
 */
function pageAddress(kind: HostKind, parts: string[]): { repo: string[]; ref: string[] | null } | null {
  if (kind === "gitlab") {
    const cut = parts.findIndex((part, index) => index >= 2 && gitlabRoutes.has(part));
    const repo = cut === -1 ? parts : parts.slice(0, cut);
    if (repo.length < 2) return null;
    const rest = cut === -1 ? [] : parts.slice(parts[cut] === "-" ? cut + 1 : cut);
    return { repo: [...repo.slice(0, -1), withoutGit(repo[repo.length - 1] ?? "")], ref: rest[0] === "tree" ? refAfter(rest, 1) : null };
  }
  const [owner, name, ...rest] = parts;
  if (!owner || !name) return null;
  let ref: string[] | null = null;
  if (kind === "github" && rest[0] === "tree") ref = refAfter(rest, 1);
  if (kind === "gitea" && (rest[0] === "src" || rest[0] === "commits") && rest[1] === "branch") ref = refAfter(rest, 2);
  if (kind === "bitbucket" && (rest[0] === "src" || rest[0] === "branch")) ref = refAfter(rest, 1);
  return { repo: [owner, withoutGit(name)], ref };
}

/** The known server a host and path belong to: the one whose prefix the path starts with, the longest prefix first. */
function knownServer(host: string, parts: string[], known: readonly KnownHost[]): KnownHost | null {
  const prefixParts = (server: KnownHost) => (server.prefix ? server.prefix.split("/") : []);
  const matches = [...wellKnown, ...known]
    .filter((server) => server.host === host)
    .filter((server) => prefixParts(server).every((part, index) => parts[index]?.toLowerCase() === part.toLowerCase()))
    .sort((a, b) => prefixParts(b).length - prefixParts(a).length);
  return matches[0] ?? null;
}

/** A repository on an https host: a known server's page address becomes the repository's clone URL. */
function httpsRepo(host: string, rawPath: string, typedUrl: string | null, known: readonly KnownHost[]): RepoParse {
  const lower = host.toLowerCase();
  // A short form names plain segments ("team//app" is a typo, not a path).
  if (typedUrl === null && !cleanSegments(trimPath(rawPath))) return fail("invalid");
  const parts = trimPath(rawPath).split("/").filter(Boolean);
  const server = knownServer(lower, parts, known);
  if (server) {
    const prefixLength = server.prefix ? server.prefix.split("/").length : 0;
    const found = pageAddress(server.kind, parts.slice(prefixLength));
    const path = found ? [...parts.slice(0, prefixLength), ...found.repo].join("/") : "";
    if (!found || !cleanSegments(path)) return fail("invalid");
    return finish({ url: `https://${lower}/${path}.git`, host: lower, path, ssh: false, ref: found.ref });
  }
  // A full URL keeps any path the host serves (percent escapes, "_git/app").
  const path = parts.join("/");
  if (path === "") return fail("invalid");
  const url = typedUrl ?? `https://${lower}/${rawPath.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  return finish({ url, host: lower, path, ssh: false, ref: null });
}

function finish(repo: RepoRef): RepoParse {
  return gitUrl.test(repo.url) ? { ok: true, repo } : fail("invalid");
}

/**
 * Reads the field's text. `known`: servers besides the well-known hosts
 * whose page addresses to read by kind (the person's GitLab and Gitea
 * connections), from knownHostsOf in repo-source.ts. `shorthand: false`
 * (the Git repository tab) takes full addresses only: owner/repo is then
 * the "shorthand" problem, since GitHub repositories have their own tab.
 */
export function parseRepoInput(input: string, known: readonly KnownHost[] = [], options: { shorthand?: boolean } = {}): RepoParse {
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
    return httpsRepo(url.host, url.pathname, typed, known);
  }

  if (/^ssh:\/\//i.test(text)) {
    if (/^ssh:\/\/[^/@]*:[^/@]*@/i.test(text)) return fail("credentials");
    const match = /^ssh:\/\/(?:[^/:@]+@)?([^/@]+)(\/.*)?$/i.exec(text);
    const host = match?.[1]?.toLowerCase();
    const path = trimPath(match?.[2] ?? "");
    if (!host || !hostName.test(host) || path === "" || !cleanSegments(path)) return fail("invalid");
    return finish({ url: text, host, path, ssh: true, ref: null });
  }

  if (/^git@/i.test(text)) {
    const match = /^git@([^:/]+):(.+)$/i.exec(text);
    const host = match?.[1]?.toLowerCase();
    const path = trimPath(match?.[2] ?? "");
    if (!host || !hostName.test(host) || path === "" || !cleanSegments(path)) return fail("invalid");
    return finish({ url: text, host, path, ssh: true, ref: null });
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
    return httpsRepo(first, rest.join("/"), null, known);
  }

  // owner/repo: a GitHub repository.
  if (rest.length === 1) {
    const name = (rest[0] ?? "").replace(/\.git$/i, "");
    if (!githubOwner.test(first) || !githubName.test(name) || name === "." || name === "..") return fail("invalid");
    if (options.shorthand === false) return fail("shorthand");
    const path = `${first}/${name}`;
    return finish({ url: `https://github.com/${path}.git`, host: "github.com", path, ssh: false, ref: null });
  }
  return rest.length > 1 && cleanSegments(text.replace(/\/+$/, "")) ? fail("needsHost") : fail("invalid");
}

/**
 * The branch a page address names. Branch names may hold slashes, so with
 * the repository's branches known it is the longest start of the ref that
 * is one of them (tree/feat/queue/src gives feat/queue), and null when none
 * is. Without a list (it failed, or there is none to read) it is the first
 * segment, unless that looks like a commit id.
 */
export function branchFromRef(ref: readonly string[] | null, branches: readonly string[] | null): string | null {
  if (!ref || ref.length === 0) return null;
  if (branches) {
    for (let length = ref.length; length > 0; length--) {
      const name = ref.slice(0, length).join("/");
      if (branches.includes(name)) return name;
    }
    return null;
  }
  const first = ref[0] ?? "";
  return first !== "" && !commitLike.test(first) ? first : null;
}
