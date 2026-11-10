// What an action card says about a tool call: "Restart api?" while it waits
// for an approval, "Restarting api" while it runs, "Restarted api" once
// done. Common ops have phrases (the assistant i18n section, `actions`);
// the rest use their own summary ("Change a service's build settings"),
// with the target shown beside it.

import { allOps } from "@seylo/ops";
import { type MessageKey, t } from "../../i18n/t";

export type Phase = "ask" | "running" | "done" | "failed";

const summaries = new Map(allOps.map((op) => [op.id, op.summary]));
const destructive = new Set(allOps.filter((op) => op.kind === "destructive").map((op) => op.id));
const queries = new Set(allOps.filter((op) => op.kind === "query").map((op) => op.id));

/** The sentence for a call of `opId` in `phase`, naming `name` (the project or service it acts on) when given. */
export function actionPhrase(opId: string, phase: Phase, name: string | undefined): string {
  const key = `assistant.actions.${opId}.${phase}` as MessageKey;
  const phrase = t(key, { name: name ?? "" });
  const found = phrase !== key;
  // A phrase that names the target needs its name; without one the summary reads better than "Restart ?".
  const needsName = found && t(key).includes("{name}");
  if (found && (!needsName || name)) return phrase;
  const summary = summaries.get(opId) ?? opId;
  return phase === "ask" ? `${summary}?` : summary;
}

/** Ops that delete data the approval card warns about. */
export function isDestructive(opId: string): boolean {
  return destructive.has(opId);
}

/** Read-only lookups: their cards are quieter, one line until opened. */
export function isLookup(opId: string): boolean {
  return queries.has(opId);
}
