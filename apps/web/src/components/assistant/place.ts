// Where the person is when they open the chat: it picks the suggestion
// chips of an empty chat and the context a new chat starts with (the panel
// keeps only a project or service the person can see).

import type { ai, OpInput } from "@seylo/ops";
import type { MessageKey } from "../../i18n/t";

export type Place =
  | { kind: "service"; projectId: string; serviceId: string }
  | { kind: "project"; projectId: string }
  | { kind: "nodes" }
  | { kind: "approvals" }
  | { kind: "activity" }
  | { kind: "general" };

const id = "([a-z0-9]{16})";
const servicePath = new RegExp(`^/p/${id}/s/${id}(?:/|$)`);
const projectPath = new RegExp(`^/p/${id}/?$`);

export function placeOf(pathname: string): Place {
  const service = servicePath.exec(pathname);
  if (service) return { kind: "service", projectId: service[1] as string, serviceId: service[2] as string };
  const project = projectPath.exec(pathname);
  if (project) return { kind: "project", projectId: project[1] as string };
  if (pathname === "/nodes" || pathname.startsWith("/nodes/")) return { kind: "nodes" };
  if (pathname.startsWith("/approvals")) return { kind: "approvals" };
  if (pathname.startsWith("/activity")) return { kind: "activity" };
  return { kind: "general" };
}

/** The suggestion chips of an empty chat, most useful first. */
export function suggestionsFor(place: Place): MessageKey[] {
  switch (place.kind) {
    case "service":
      return [
        "assistant.suggestions.service.lastDeploy",
        "assistant.suggestions.service.logs",
        "assistant.suggestions.service.usage",
        "assistant.suggestions.service.restart",
      ];
    case "project":
      return ["assistant.suggestions.project.overview", "assistant.suggestions.project.down", "assistant.suggestions.project.recent"];
    case "nodes":
      return ["assistant.suggestions.nodes.health", "assistant.suggestions.nodes.space", "assistant.suggestions.general.attention"];
    case "approvals":
      return ["assistant.suggestions.approvals.waiting", "assistant.suggestions.general.attention"];
    case "activity":
      return ["assistant.suggestions.activity.recent", "assistant.suggestions.general.failed"];
    case "general":
      return ["assistant.suggestions.general.attention", "assistant.suggestions.general.list", "assistant.suggestions.general.failed"];
  }
}

/** ai.send's context: the page a new chat was opened from. */
export type ChatContext = NonNullable<OpInput<typeof ai.send>["context"]>;

export function contextOf(place: Place): ChatContext {
  if (place.kind === "service") return { projectId: place.projectId, serviceId: place.serviceId };
  if (place.kind === "project") return { projectId: place.projectId };
  return {};
}
