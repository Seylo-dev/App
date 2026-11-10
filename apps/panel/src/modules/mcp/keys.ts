// Settings keys of the MCP server, declared by augmenting SettingValues.

import type { PanelDb } from "../../db/client";
import { getSetting } from "../../settings";

declare module "../../settings" {
  interface SettingValues {
    /** The MCP endpoint is off until the owner turns it on. */
    mcpEnabled: boolean;
    /**
     * Destructive calls from MCP tokens wait for a person's approval
     * (ops/pipeline.ts). Missing means on.
     */
    mcpAskBeforeDestructive: boolean;
    /** The OAuth consent page preselects read only (pages.ts). Missing means on. */
    mcpReadOnlyByDefault: boolean;
  }
}

export function readMcpEnabled(db: PanelDb): boolean {
  return getSetting(db, "mcpEnabled") ?? false;
}

/** The MCP card's two safety switches: on until someone with mcp.manage turns them off. */
export function readMcpSafety(db: PanelDb): { askBeforeDestructive: boolean; readOnlyByDefault: boolean } {
  return {
    askBeforeDestructive: getSetting(db, "mcpAskBeforeDestructive") ?? true,
    readOnlyByDefault: getSetting(db, "mcpReadOnlyByDefault") ?? true,
  };
}
