// Follow-up runs of a job that polls (an update run waiting for its step).
// The jobs table allows one queued or running job per dedupe key and a
// running job still holds its own key, so the next run gets a key of its
// own. Fixed schedules use deps.schedules instead.

import type { Deps } from "../../deps";

/** From inside the running job: enqueue the next run. */
export function enqueueNext(deps: Pick<Deps, "jobs"> & { jobId: string }, type: string, runAt: Date, payload: unknown = {}): void {
  deps.jobs.enqueue(type, payload, { runAt, dedupeKey: `${type}:after:${deps.jobId}` });
}
