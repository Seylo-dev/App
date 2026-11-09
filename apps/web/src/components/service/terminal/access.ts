// Which terminal modes the signed-in person may open on a service, so the
// Console tab and the Overview card only offer those. The same rule as the
// panel (apps/panel/src/auth/access.ts): owners and admins may do
// everything; a member needs terminals.console or terminals.shell in a grant
// on the service or on its project. The panel still checks every ticket.

import { actionAllowed, auth, grants, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import type { ServiceDetail } from "../use-service";

export type TerminalMode = "console" | "shell";

export const terminalModes: readonly TerminalMode[] = ["console", "shell"];

const actionOf: Record<TerminalMode, string> = { console: "terminals.console", shell: "terminals.shell" };

type Grant = OpOutput<typeof grants.mine>["grants"][number];

/** The modes a member's grants allow on this service, in switch order. */
export function allowedModes(
  memberGrants: readonly Pick<Grant, "scopeType" | "scopeId" | "actions">[],
  service: Pick<ServiceDetail, "id" | "projectId">,
): TerminalMode[] {
  const here = memberGrants.filter(
    (g) => (g.scopeType === "service" && g.scopeId === service.id) || (g.scopeType === "project" && g.scopeId === service.projectId),
  );
  return terminalModes.filter((mode) => here.some((g) => actionAllowed(g.actions, actionOf[mode])));
}

/** The mode to show: the one asked for when allowed, else the first allowed one; null when none is. */
export function pickMode(wanted: TerminalMode, allowed: readonly TerminalMode[]): TerminalMode | null {
  return allowed.includes(wanted) ? wanted : (allowed[0] ?? null);
}

/**
 * The modes this person may open here; null while that is not known yet
 * (a member's grants are loading). When the grants cannot be read, every
 * mode is offered and the panel's answer says what is not allowed.
 */
export function useTerminalModes(service: Pick<ServiceDetail, "id" | "projectId">): readonly TerminalMode[] | null {
  const me = useOp(auth.whoami, {});
  const member = me.data?.viewer.role === "member";
  const mine = useOp(grants.mine, {}, { enabled: member });
  if (me.isPending) return null;
  if (!member) return terminalModes;
  if (mine.isError) return terminalModes;
  if (!mine.data) return null;
  return allowedModes(mine.data.grants, service);
}
