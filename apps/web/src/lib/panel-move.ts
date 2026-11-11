// Following a panel move from the old panel's page (0.2.8). At the end of a
// move the old panel answers "done, side old" for about a second, then its
// node stops it for good. A page that missed that second (a hidden tab does
// not poll, a visible one can lose the race) only sees its status reads
// fail. Once the move it followed got to telling the nodes the new address,
// such a failure most likely means the move went through, so the card and
// the banner show where the panel went (from the last status) instead of a
// load error, and the page stops asking the dead address after a while.

import { OpError, type OpOutput, type panelMove } from "@seylo/ops";

type MoveStatus = OpOutput<typeof panelMove.status>;

/**
 * The steps from which a failed status read means the panel most likely
 * moved: the nodes know the new address. "committing" is the old panel's
 * journal phase between the two; listed in case a status names it.
 */
const lateSteps: ReadonlySet<string> = new Set(["staging", "committing", "switching"]);

/** How long after its last answer the page keeps asking a panel that stopped answering at the end of a move. */
export const lostPollMs = 2 * 60_000;

/**
 * An error a stopped panel produces: no answer at all, a 5xx (a proxy in
 * front of it, a 503), or a page that is not the panel's (a proxy's 404).
 * Not a refusal of the panel itself, such as a sign-in that ran out.
 */
function deadPanel(error: unknown): boolean {
  if (!error) return false;
  if (!(error instanceof OpError)) return true;
  return error.code === "UNAVAILABLE" || error.code === "INTERNAL";
}

/**
 * The last status, as the old copy's "moved" status, when the move this
 * page followed got to its last steps and the panel stopped answering since;
 * null otherwise.
 */
export function lostMove(query: { data?: MoveStatus | undefined; error: unknown }): MoveStatus | null {
  const last = query.data;
  if (last?.state !== "running" || last.step === null || !lateSteps.has(last.step)) return null;
  if (!deadPanel(query.error)) return null;
  return { ...last, state: "done", side: "old", canCancel: false, canForceCancel: false, waitingSince: null };
}

/**
 * Where the old copy sends people: the new IP address first, since the
 * domain's DNS record still points at the old server right after a move;
 * the domain second, for once its record points at the new one.
 */
export function movedLinks(status: Pick<MoveStatus, "newUrl" | "domain">): { url: string | null; domainUrl: string | null } {
  const domainUrl = status.domain ? `https://${status.domain}` : null;
  if (!status.newUrl) return { url: domainUrl, domainUrl: null };
  return { url: status.newUrl, domainUrl };
}

interface StatusQuery {
  state: { data?: MoveStatus | undefined; error: unknown; dataUpdatedAt: number };
}

/**
 * refetchInterval for panelMove.status: every `intervalMs` while a move
 * runs, never otherwise, and no more once the panel stopped answering at
 * the end of the move for lostPollMs.
 */
export function followMovePoll(intervalMs: number, now: () => number = Date.now) {
  return (query: StatusQuery): number | false => {
    const { data, error, dataUpdatedAt } = query.state;
    if (data?.state !== "running") return false;
    if (lostMove({ data, error }) && now() - dataUpdatedAt > lostPollMs) return false;
    return intervalMs;
  };
}
