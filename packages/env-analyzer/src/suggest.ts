// "Did you mean": the known names a typo away from what was written, for
// the unknown-service and unknown-variable fixes and the bare-reference hint.

import type { QuickFix, SourceRange } from "./types";

/**
 * Known names a typo away from wrong (case or up to two edits): all the
 * ones at the smallest distance, in the order given. Short names get fewer
 * edits, so "db" never suggests "api".
 */
export function closestNames(wrong: string, known: readonly string[]): string[] {
  const limit = wrong.length >= 6 ? 2 : wrong.length >= 3 ? 1 : 0;
  let best: string[] = [];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of known) {
    if (name === wrong) continue;
    const distance = editDistance(name.toLowerCase(), wrong.toLowerCase());
    if (distance > limit || distance > bestDistance) continue;
    if (distance < bestDistance) {
      best = [];
      bestDistance = distance;
    }
    if (!best.includes(name)) best.push(name);
  }
  return best;
}

/** A "Did you mean" fix that writes the closest known name over range. */
export function suggest(wrong: string, known: readonly string[], range: SourceRange): QuickFix[] {
  const [name] = closestNames(wrong, known);
  return name ? [{ kind: "edit", title: `Change to ${name}`, edits: [{ range, text: name }] }] : [];
}

/** Levenshtein distance, small inputs only. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
