// First-run setup: the installer's one-time link, creating the owner
// (email and password or GitHub device flow) and finishing the wizard.
// Contracts: packages/ops/src/ops/setup.ts. The token lifecycle is
// src/auth/setup-token.ts.

import { OpError, setup } from "@seylo/ops";
import { githubAvailable, startDeviceFlow } from "../../auth/github-device";
import { ownerExists, prepareSetupLink, validSetupToken } from "../../auth/setup-token";
import { implement } from "../../ops/implement";
import { getSetting, setSetting } from "../../settings";
import { defineModule } from "../module";
import { setupTelemetry } from "../telemetry";
import { createOwner, githubPoll, requireUsableLink } from "./owner";

// Settings this module owns.
declare module "../../settings" {
  interface SettingValues {
    /** ISO time setup.finish ran; absent while the wizard is still offered. */
    setupCompletedAt: string;
  }
}

const steps = ["owner", "panelDomain", "wildcardDomain", "firstProject"] as const;

const status = implement(setup.status, (input, ctx) => {
  const hasOwner = ownerExists(ctx.db);
  let link: { valid: boolean; expiresAt: string | null } | null = null;
  if (input.token !== undefined) {
    const row = hasOwner ? undefined : validSetupToken(ctx.db, input.token);
    link = { valid: row !== undefined, expiresAt: row?.expiresAt.toISOString() ?? null };
  }
  return {
    ownerExists: hasOwner,
    completed: getSetting(ctx.db, "setupCompletedAt") !== undefined,
    link,
    githubAvailable: githubAvailable(ctx),
    steps: [...steps],
    telemetry: setupTelemetry(ctx),
  };
});

const githubStart = implement(setup.githubStart, (input, ctx) => {
  requireUsableLink(ctx.db, input.token);
  return startDeviceFlow(ctx, "githubSetup", { repoAccess: input.repoAccess });
});

const finish = implement(setup.finish, (_input, ctx) => {
  if (!ownerExists(ctx.db)) throw new OpError("CONFLICT", "Create the owner account first.");
  if (getSetting(ctx.db, "setupCompletedAt") === undefined) setSetting(ctx.db, "setupCompletedAt", new Date().toISOString());
  return {};
});

export default defineModule({
  name: "setup",
  ops: [status, createOwner, githubStart, githubPoll, finish],
  start: (deps) => prepareSetupLink(deps.db, deps.config.dataDir, deps.logger.child({ component: "setup" })),
});
