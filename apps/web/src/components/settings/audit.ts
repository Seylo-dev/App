// Turning audit entries into what the Activity page shows: the action
// sentence for an op id, filters as op input, and a download helper.

import { allOps, type audit, type OpInput } from "@seylo/ops";
import { t } from "../../i18n/t";
import { areaLabel, humanize } from "./actions";

const summaries = new Map(allOps.map((op) => [op.id, op.summary]));

/** Audit entries the panel writes outside the op registry (the MCP OAuth endpoints). */
const notOps: Record<string, () => string> = {
  "mcp.registerClient": () => t("activity.events.mcpRegisterClient"),
  "mcp.authorizeClient": () => t("activity.events.mcpAuthorizeClient"),
};

/**
 * What an op did, for example "Deploy a service". The summary comes from
 * the op contract (the same text the API reference and MCP show); ops
 * removed since fall back to their id in words.
 */
export function opSentence(opId: string): string {
  const special = notOps[opId];
  if (special) return special();
  const summary = summaries.get(opId);
  if (summary) return summary;
  const dot = opId.indexOf(".");
  return dot > 0 ? `${areaLabel(opId.slice(0, dot))}: ${humanize(opId.slice(dot + 1))}` : opId;
}

/** Op modules that exist, for the "Area" filter, sorted. */
export const opModules = [...new Set(allOps.map((op) => op.id.slice(0, op.id.indexOf("."))))].sort();

export interface ActivityFilters {
  q: string;
  actorType: string;
  module: string;
  outcome: string;
  /** yyyy-mm-dd from a date input, in the reader's time zone. */
  from: string;
  to: string;
}

export const emptyFilters: ActivityFilters = { q: "", actorType: "all", module: "all", outcome: "all", from: "", to: "" };

type ListInput = Omit<OpInput<typeof audit.list>, "cursor">;

/** Filters as audit.list input; "to" covers its whole day. */
export function filtersToInput(filters: ActivityFilters, limit = 50): ListInput {
  const input: ListInput = { limit };
  const q = filters.q.trim();
  if (q) input.q = q.slice(0, 100);
  if (filters.actorType !== "all") input.actorType = filters.actorType as ListInput["actorType"];
  if (filters.module !== "all") input.opId = `${filters.module}.`;
  if (filters.outcome !== "all") input.outcome = filters.outcome as ListInput["outcome"];
  if (filters.from) input.from = new Date(`${filters.from}T00:00:00`).toISOString();
  if (filters.to) input.to = new Date(`${filters.to}T23:59:59.999`).toISOString();
  return input;
}

/** Saves text as a file in the browser. */
export function downloadText(filename: string, contentType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
