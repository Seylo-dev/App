// What a push changed, read from the push payloads of GitHub, GitLab and
// Gitea (commits[].added/modified/removed), which all share that shape, and
// from the deploy trigger URL's body. Used for watch paths and [skip ci].

/** The changes of one push as far as the payload tells them. */
export interface PushChanges {
  /** Changed files from the payload; null when it lists none. */
  files: string[] | null;
  /** The payload's list may miss files (the provider cut the commit list). */
  truncated: boolean;
  /** Commit before the push; null for a new branch or when unknown. */
  before: string | null;
  /** Commit after the push (the new head). */
  after: string | null;
  /** Full message of the head commit, for [skip ci] markers. */
  headMessage: string | null;
}

interface PayloadCommit {
  id?: unknown;
  message?: unknown;
  added?: unknown;
  modified?: unknown;
  removed?: unknown;
}

/** Most files kept from one payload; more counts as truncated. */
const maxFiles = 20_000;
/** GitHub lists at most this many commits in a push payload and sends no total. */
const githubCommitCap = 2048;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const sha = (value: unknown): string | null => (typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value) ? value.toLowerCase() : null);

/**
 * Changed files of a list of payload commits. Null when the list is empty
 * (a push of commits the branch already had, or a provider that sends none).
 */
export function filesFromCommits(commits: unknown): { files: string[] | null; capped: boolean } {
  if (!Array.isArray(commits) || commits.length === 0) return { files: null, capped: false };
  const files = new Set<string>();
  let listed = false;
  for (const raw of commits as PayloadCommit[]) {
    if (!raw || typeof raw !== "object") continue;
    for (const key of ["added", "modified", "removed"] as const) {
      if (Array.isArray(raw[key])) listed = true;
      for (const file of strings(raw[key])) {
        if (files.size >= maxFiles) return { files: [...files], capped: true };
        files.add(file);
      }
    }
  }
  return { files: listed ? [...files] : null, capped: false };
}

/**
 * Reads a push payload in the GitHub, GitLab or Gitea shape (or a plain
 * { changedFiles: [...] } from CI). Returns null when the body is no push.
 */
export function changesFromPushPayload(payload: unknown): PushChanges | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const explicit = Array.isArray(p.changedFiles) ? strings(p.changedFiles) : null;
  if (!Array.isArray(p.commits) && explicit === null) return null;
  const commits = Array.isArray(p.commits) ? (p.commits as PayloadCommit[]) : [];
  const after = sha(p.after) ?? sha(p.checkout_sha) ?? null;
  const head =
    (p.head_commit && typeof p.head_commit === "object" ? (p.head_commit as PayloadCommit) : null) ??
    commits.find((c) => c && typeof c === "object" && sha(c.id) === after) ??
    commits.at(-1) ??
    null;
  const fromCommits = filesFromCommits(commits);
  // GitLab: total_commits_count; Gitea: total_commits. More than listed = the list was cut.
  const total =
    typeof p.total_commits_count === "number" ? p.total_commits_count : typeof p.total_commits === "number" ? p.total_commits : null;
  const files = explicit ?? fromCommits.files;
  return {
    files,
    truncated: explicit === null && (fromCommits.capped || commits.length >= githubCommitCap || (total !== null && total > commits.length)),
    before: sha(p.before),
    after,
    headMessage: head && typeof head.message === "string" ? head.message : null,
  };
}

/** First line of a commit message, for the deployment row. */
export function firstLine(message: string | null | undefined): string | null {
  if (!message) return null;
  return message.split("\n")[0]?.trim() || null;
}
