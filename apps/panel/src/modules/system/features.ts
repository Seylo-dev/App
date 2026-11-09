import { isPlaceholder, oauthClientId } from "@seylo/brand";
import { system } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { notificationChannels } from "../../db/schema";
import { implement } from "../../ops/implement";
import { getSetting } from "../../settings";
import { readAiSettings } from "../ai/keys";
import { readMcpEnabled } from "../mcp/keys";
import "../settings/keys";

const on = { enabled: true, reason: "" };
const off = (reason: string) => ({ enabled: false, reason });

export const features = implement(system.features, (_input, ctx) => {
  const ai = readAiSettings(ctx.db);
  const domain = getSetting(ctx.db, "panelDomain") ?? null;
  const channel = ctx.db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(eq(notificationChannels.enabled, true))
    .limit(1)
    .get();
  return {
    githubSignIn: isPlaceholder(oauthClientId) ? off("This build has no GitHub OAuth app configured.") : on,
    passkeys: domain ? on : off("Passkeys need a panel domain. Set one in Settings > General."),
    mcp: readMcpEnabled(ctx.db) ? on : off("The MCP server is off. Turn it on in Settings > API keys and MCP."),
    ai: !ai.keySealed
      ? off("Add an Anthropic API key in Settings > AI assistant.")
      : ai.enabled
        ? on
        : off("The AI assistant is turned off."),
    // The same rule as the send job: the setting, unless a variable on the container turns reports off.
    // Read without readTelemetry, which would write an install id from a query.
    telemetry:
      getSetting(ctx.db, "telemetry")?.enabled === true && !ctx.config.telemetryOffBy
        ? on
        : off(
            ctx.config.telemetryOffBy
              ? `${ctx.config.telemetryOffBy} on the panel's container turns reports off.`
              : "Telemetry is turned off. Turn it on in Settings > Telemetry.",
          ),
    notifications: channel ? on : off("Add a notification channel in Settings > Notifications."),
  };
});
