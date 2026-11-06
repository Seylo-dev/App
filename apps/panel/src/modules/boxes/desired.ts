// The Box part of a ServiceSpec, for the desired-state compiler: the
// BoxSpec (kind_spec "box") with the workspace volume and idle timeout.
// Image, entrypoint, port and volume are in the services spec written at
// create; BOX_REPOSITORY comes with the env (env/desired.ts).

import type { MessageInitShape } from "@bufbuild/protobuf";
import type { BoxSpecSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { serviceBoxes } from "../../db/schema";
import type { Deps } from "../../deps";

/** Volume (from the services spec) that holds the workspace. */
export const boxWorkspaceVolume = "home";

/** Null for services that are not Boxes. idleMinutes 0 (never sleep) sends no timeout. */
export function boxRuntime(deps: Pick<Deps, "db">, serviceId: string): { box: MessageInitShape<typeof BoxSpecSchema> } | null {
  const row = deps.db.select().from(serviceBoxes).where(eq(serviceBoxes.serviceId, serviceId)).get();
  if (!row) return null;
  return {
    box: {
      workspaceVolume: boxWorkspaceVolume,
      idleTimeout: row.idleMinutes > 0 ? { seconds: BigInt(row.idleMinutes * 60) } : undefined,
    },
  };
}

/** Environment the Box entrypoint reads. */
export function boxEnv(deps: Pick<Deps, "db">, serviceId: string): Record<string, string> {
  const row = deps.db.select().from(serviceBoxes).where(eq(serviceBoxes.serviceId, serviceId)).get();
  return row?.repository ? { BOX_REPOSITORY: row.repository } : {};
}
