// What making a service hands out beyond services.create. A service's env
// (env.edit), its file mounts (files.write) and running it (services.deploy,
// the first deployment) are their own permissions on the project, whichever
// op does it: services.create, templates.create, dockerHub.create,
// compose.create and compose.update, databases.create and boxes.create
// check them here, services.clone copies env and files only with them and
// services.start of a never-deployed service needs services.deploy. So a
// grant of services.create alone makes services that someone who may run
// them starts.

import { type Action, OpError } from "@seylo/ops";
import type { Target } from "../../auth/access";
import type { OpContext } from "../../ops/implement";

export interface CreateNeeds {
  /** The new service gets an env the caller wrote or picked (not one the panel generates, like a database's). */
  env?: boolean;
  /** It gets file mounts. */
  files?: boolean;
  /** It is deployed right away. */
  deploy?: boolean;
}

const reasons: Record<keyof CreateNeeds, { action: Action; message: string }> = {
  env: {
    action: "env.edit",
    message:
      "Setting a service's environment variables needs the env.edit permission in this project. Leave them out, or ask someone who has it.",
  },
  files: {
    action: "files.write",
    message: "Adding file mounts needs the files.write permission in this project. Ask someone who has it.",
  },
  deploy: {
    action: "services.deploy",
    message:
      "Deploying a new service needs the services.deploy permission in this project. Create it without deploying (deployNow: false) where that is possible, or ask someone who can deploy.",
  },
};

/**
 * FORBIDDEN (details.action) unless the caller holds what the new service
 * needs, in the project (or on the stack, for a compose file's members).
 */
export function assertCreateRights(ctx: Pick<OpContext, "access">, scope: Target, needs: CreateNeeds): void {
  for (const key of ["env", "files", "deploy"] as const) {
    if (!needs[key]) continue;
    const { action, message } = reasons[key];
    if (!ctx.access.can(action, scope)) throw new OpError("FORBIDDEN", message, { action });
  }
}
