// Following a panel move from the old panel's page (0.2.8). At the end of a
// move the old panel answers "done, side old" for about a second, then its
// node stops it for good. A page that missed that second (a hidden tab does
// not poll, a visible one can lose the race) only sees its status reads
// fail. So a status read that fails while the last status said the move
// runs never shows as a plain load error: the card and the banner show the
// new address from the last status. Once the switch went ahead such a
// failure most likely means the move went through ("moved"); before it,
// nothing is committed and an old panel that comes back fails the move
// (recover.ts), so the page only says where the panel is if the move
// finished, and keeps asking this server, less often.

import { OpError, type OpOutput, type panelMove } from "@seylo/ops";

type MoveStatus = OpOutput<typeof panelMove.status>;

/** How long after its last answer the page asks a panel that stopped answering mid-move as often as before. */
export const lostPollMs = 2 * 60_000;
/** How often the page then asks it again, for a move that may still fail back here. */
export const lostRetryMs = 30_000;

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
 * The switch went ahead: the old panel sent the commit to the target and
 * the target did not keep it waiting. From here the old panel only stops
 * once the move is done ("committing" is the old panel's journal phase,
 * shown as switching; listed in case a status names it).
 */
function switched(status: MoveStatus): boolean {
  return (status.step === "switching" || (status.step as string) === "committing") && status.waitingSince === null;
}

/**
 * The old panel stopped answering a page that followed a running move.
 * moved: it got past the switch, so it most likely moved, and `status` is
 * the old copy's "moved" status. Otherwise `status` is the last one: the
 * move may have finished, or it fails back here once the old panel is back.
 */
export interface LostMove {
  status: MoveStatus;
  moved: boolean;
}

/** The move this page followed when the panel stopped answering since its last status; null otherwise. */
export function lostMove(query: { data?: MoveStatus | undefined; error: unknown }): LostMove | null {
  const last = query.data;
  if (last?.state !== "running" || !deadPanel(query.error)) return null;
  if (!switched(last)) return { status: last, moved: false };
  return {
    status: { ...last, state: "done", side: "old", canCancel: false, canForceCancel: false, waitingSince: null },
    moved: true,
  };
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
 * runs, never otherwise. Once the panel stopped answering for lostPollMs:
 * no more after the switch (it stopped for good), every lostRetryMs before
 * it (it may come back and fail the move).
 */
export function followMovePoll(intervalMs: number, now: () => number = Date.now) {
  return (query: StatusQuery): number | false => {
    const { data, error, dataUpdatedAt } = query.state;
    if (data?.state !== "running") return false;
    const lost = lostMove({ data, error });
    if (!lost || now() - dataUpdatedAt <= lostPollMs) return intervalMs;
    return lost.moved ? false : Math.max(intervalMs, lostRetryMs);
  };
}
