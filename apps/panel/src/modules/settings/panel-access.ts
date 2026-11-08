// settings.panelAccess and settings.updatePanelAccess (added in 0.2.1):
// the Panel domain card's "Serve on IP address" and "Agents' port"
// switches. The decision itself is applyPanelIpAccess (ip-access.ts); the
// ways in that keep working are private-paths.ts.
//
// Not built yet (WP-F2b): both answer NOT_IMPLEMENTED, so IP access stays
// open as in 0.2.0.

import { settings } from "@seylo/ops";
import { notImplemented } from "../../ops/implement";

export const panelAccessOp = notImplemented(settings.panelAccess);

export const updatePanelAccess = notImplemented(settings.updatePanelAccess);
