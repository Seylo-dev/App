// A compose member's environment: is written to its .env as is, so a
// ${{payments.STRIPE_KEY}} in the file is a live reference the container
// resolves. The same rule as env.set applies: a person may only write
// references to values they can read (the stack's own members count as
// their own). A push has no person behind it, so it may not add references
// to values outside the stack that the member did not already have.

import { parseEnv } from "@seylo/env-analyzer";
import { OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { services } from "../../db/schema";
import type { Deps } from "../../deps";
import type { OpContext } from "../../ops/implement";
import { buildEnvGraph, isCredentialVariable } from "../env/graph";
import { checkEnvReferences, hiddenReference } from "../env/ops";
import { readServiceEnv } from "../env/store";
import type { ServiceRow } from "../services/rows";
import { readSpec } from "../services/spec";
import { envText, type StackPlan } from "./plan";

/** Refuses the plan when a member references a value the caller cannot read. */
export function assertPlanReferences(ctx: OpContext, projectId: string, plan: StackPlan): void {
  const self = plan.members.map((m) => m.name);
  const graph = buildEnvGraph(ctx, projectId);
  for (const p of plan.members) checkEnvReferences(ctx, projectId, self, envText(p.env), { graph, where: p.composeService });
}

/**
 * For a push (no person to check): every reference outside the stack must
 * be an address (a non-credential built-in) or one the member already had.
 */
export function assertPushReferences(deps: Pick<Deps, "db" | "secrets">, stack: ServiceRow, plan: StackPlan): void {
  const members = deps.db.select().from(services).where(eq(services.parentId, stack.id)).all();
  const graph = buildEnvGraph(deps, stack.projectId);
  const self = new Set(plan.members.map((m) => m.name.toLowerCase()));
  const byCompose = new Map(members.map((m) => [readSpec(m.spec).member?.composeService ?? m.name, m]));
  for (const p of plan.members) {
    const current = byCompose.get(p.composeService);
    const before = new Set(
      current
        ? parseEnv(readServiceEnv(deps.db, deps.secrets, current.id).text).entries.flatMap((e) =>
            e.references.map((r) => `${r.target}.${r.variable}`.toLowerCase()),
          )
        : [],
    );
    const hidden = hiddenReference(graph, self, parseEnv(envText(p.env)), (target, variable) => {
      if (before.has(`${target === "shared" ? "project" : target.row.name}.${variable}`.toLowerCase())) return true;
      return target !== "shared" && !isCredentialVariable(target, variable) && target.builtins.some((b) => b.name === variable);
    });
    if (hidden) {
      throw new OpError(
        "FORBIDDEN",
        `${p.composeService}: the compose file now references ${hidden.reference} in ${hidden.key}. Apply this change from the panel, where it is checked against your permissions.`,
        { reference: hidden.reference, service: p.composeService },
      );
    }
  }
}
