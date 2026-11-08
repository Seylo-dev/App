// `seylo panel ip-access on` (go/internal/cli/panel_ipaccess.go) writes
// <data dir>/panel/ip-access-on and restarts the panel container: the way
// back in when IP access is closed and its private path is gone. The panel
// reads the file on start (and on the 1-minute IP access job, in case the
// restart did not happen): both switches go back on, "If the domain stops
// working" goes back to "reopen", an audit row records it, the file is
// removed and applyPanelIpAccess reopens the port (one more short restart).

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { auditLog } from "../../db/schema";
import type { Deps } from "../../deps";
import { applyPanelIpAccess, ipAccessOnCommand, writePanelAccessChoice } from "./ip-access";

/** The marker's name inside the panel's data dir. */
export const ipAccessOnFile = "ip-access-on";

/** Who the change is recorded as. */
export const serverCommandLine = "the server's command line";

/** Applies the marker when it is there; true when it was. */
export function applyIpAccessFile(deps: Deps, now = new Date()): boolean {
  const file = join(deps.config.dataDir, ipAccessOnFile);
  if (!existsSync(file)) return false;
  const reason = `reopened from the server's command line (${ipAccessOnCommand})`;
  writePanelAccessChoice(
    deps,
    { serveOnIp: true, agentPortOpen: true, onFailure: "reopen" },
    { reason, by: serverCommandLine, at: now.getTime() },
  );
  deps.db
    .insert(auditLog)
    .values({
      at: now,
      actorType: "system",
      actorId: null,
      credentialId: null,
      actorLabel: serverCommandLine,
      opId: "settings.ipAccessOnFromServer",
      targetType: null,
      targetId: null,
      targetLabel: null,
      projectId: null,
      transport: "http",
      input: { command: ipAccessOnCommand, serveOnIp: true, agentPortOpen: true, onFailure: "reopen" },
      outcome: "ok",
      errorCode: null,
      durationMs: 0,
      ip: null,
      userAgent: null,
      approvalId: null,
    })
    .run();
  try {
    rmSync(file, { force: true });
  } catch (error) {
    // Applying it again on the next start changes nothing: the switches are already on.
    deps.logger.warn({ err: error, file }, "could not remove the ip-access-on marker");
  }
  deps.logger.info({ file }, "IP access turned back on from the server's command line");
  applyPanelIpAccess(deps, reason, {
    by: serverCommandLine,
    resetHold: true,
    now: now.getTime(),
  });
  deps.live.publish("panel", { type: "invalidate", ops: ["settings.panelAccess"] });
  return true;
}
