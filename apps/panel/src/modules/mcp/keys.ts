// Settings key of the MCP server, declared by augmenting SettingValues.

import type { PanelDb } from "../../db/client";
import { getSetting } from "../../settings";

declare module "../../settings" {
  interface SettingValues {
    /** The MCP endpoint is off until the owner turns it on. */
    mcpEnabled: boolean;
  }
}

export function readMcpEnabled(db: PanelDb): boolean {
  return getSetting(db, "mcpEnabled") ?? false;
}
