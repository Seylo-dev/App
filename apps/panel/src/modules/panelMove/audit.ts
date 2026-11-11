// Audit rows the move writes itself, outside an op: the switch, a failure,
// the arrival, a forced cancel that the target contradicts. Never a secret
// in `input`.

import { auditLog } from "../../db/schema";
import type { Deps } from "../../deps";

/** An audit row with actor "system" (who started the move goes in `input.by`). */
export function writeMoveAudit(
  deps: Pick<Deps, "db" | "logger">,
  opId: string,
  input: Record<string, unknown>,
  error: string | null = null,
): void {
  try {
    deps.db
      .insert(auditLog)
      .values({
        at: new Date(),
        actorType: "system",
        actorId: null,
        credentialId: null,
        actorLabel: "system",
        opId,
        targetType: null,
        targetId: null,
        targetLabel: null,
        projectId: null,
        transport: "http",
        input,
        outcome: error ? "error" : "ok",
        errorCode: error,
        durationMs: 0,
        ip: null,
        userAgent: null,
        approvalId: null,
      })
      .run();
  } catch (failure) {
    deps.logger.error({ err: failure, opId }, "writing the panel move's audit row failed");
  }
}
