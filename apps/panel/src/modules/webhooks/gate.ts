// Whether a push deploys a service: [skip ci] / [skip cd] in the head
// commit message skips it, and watch paths decide by the changed files.
// The files come from the push payload; when it lists none or cut the
// list short, from the provider's compare API between before and after.
// When the files still cannot be known, the push deploys: a watch path
// never skips a push silently. Every path that deploys on push uses this:
// GitHub webhooks and polling, GitLab, Gitea/Forgejo and Bitbucket
// webhooks and polling, and the deploy trigger URL.

import { describeWatchPaths, matchWatchPaths, skipMarkerOf, type WatchPathsResult } from "@seylo/ops";
import type { PushChanges } from "./changes";

export interface ChangedFileList {
  files: string[];
  /** False when the provider capped the list. */
  complete: boolean;
}

/** Asks the provider for the files between two commits; null when it cannot be asked. */
export type CompareFiles = ((before: string, after: string) => Promise<ChangedFileList>) | null;

export interface GateResult {
  deploy: boolean;
  /** Why, in one line: the delivery log's detail for a skip, a deploy log line otherwise. */
  detail: string;
  /** Lines for the deployment's log when it deploys (empty without watch paths). */
  logLines: string[];
}

const nullSha = /^0+$/;

/** Decides one push for a service with these watch paths. */
export async function pushGate(input: {
  watchPaths: readonly string[];
  changes: PushChanges;
  compare: CompareFiles;
  /** For log lines: "GitLab", "GitHub". */
  providerLabel?: string;
}): Promise<GateResult> {
  const { changes, watchPaths } = input;
  const marker = skipMarkerOf(changes.headMessage);
  if (marker) return { deploy: false, detail: `Skipped: the head commit message says ${marker}.`, logLines: [] };
  if (watchPaths.length === 0) return { deploy: true, detail: "", logLines: [] };

  let result: WatchPathsResult | null = null;
  const lines: string[] = [];
  if (changes.files !== null) {
    result = matchWatchPaths(watchPaths, changes.files, !changes.truncated);
    if (result.reason === "matched" || result.reason === "noMatch") return finish(result, lines);
  }
  // The payload did not settle it: ask the provider what changed.
  const before = changes.before;
  if (input.compare && before && changes.after && !nullSha.test(before) && !nullSha.test(changes.after)) {
    try {
      const listed = await input.compare(before, changes.after);
      return finish(matchWatchPaths(watchPaths, listed.files, listed.complete), lines);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`Watch paths: asking ${input.providerLabel ?? "the provider"} for the changed files failed (${message.slice(0, 200)}).`);
    }
  }
  return finish(result ?? matchWatchPaths(watchPaths, null), lines);
}

function finish(result: WatchPathsResult, lines: string[]): GateResult {
  const detail = describeWatchPaths(result);
  return { deploy: result.deploy, detail, logLines: result.deploy ? [...lines, detail] : lines };
}
