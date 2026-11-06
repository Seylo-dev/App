// Who may subscribe to which live topic. Mirrors the "view" permissions of
// the ops whose results the topic's events invalidate.

import type { LiveTopic } from "@seylo/ops";
import { eq } from "drizzle-orm";
import type { Access } from "../auth/access";
import type { PanelDb } from "../db/client";
import { aiConversations, deployments } from "../db/schema";

export function maySubscribe(access: Access, topic: LiveTopic, db: PanelDb): boolean {
  if (access.principal.type === "anonymous") return false;
  if (topic === "panel") return true;
  const [kind, id] = topic.split(":") as [string, string];
  switch (kind) {
    case "project":
      return access.can("projects.view", { type: "project", id });
    case "service":
      return access.can("services.view", { type: "service", id });
    case "node":
      return access.can("nodes.view");
    case "deployment": {
      const row = db.select({ serviceId: deployments.serviceId }).from(deployments).where(eq(deployments.id, id)).get();
      return row !== undefined && access.can("services.view", { type: "service", id: row.serviceId });
    }
    case "ai": {
      // Only the person who owns the conversation; not even admins read other people's chats live.
      const row = db.select({ userId: aiConversations.userId }).from(aiConversations).where(eq(aiConversations.id, id)).get();
      return row !== undefined && access.principal.type === "session" && row.userId === access.principal.user.id;
    }
    default:
      return false;
  }
}
