// The cleanup schedule a node runs by itself (NodeSettings.cleanup): the
// stored shape, its checks, the desired-state mapping and the next run in
// the node's own time zone.

import { create } from "@bufbuild/protobuf";
import { type cleanup, OpError, type OpOutput } from "@seylo/ops";
import { type CleanupSchedule, CleanupScheduleSchema } from "@seylo/proto";
import { parseVersion } from "../../agent-hub/version";
import type { CleanupScheduleJson, nodes } from "../../db/schema";
import { isTimeZone, nextCronRun, nodeCronProblem, normalizeCronSchedule } from "../../jobs/cron-expr";

type Schedule = OpOutput<typeof cleanup.getSchedule>["schedule"];

/**
 * On unless turned off (since 0.2.5; before, off until turned on): daily at
 * 04:00 node time and above 80% disk, without volumes. A node that never had
 * a schedule saved follows this; one saved off stays off.
 */
export const defaultSchedule: CleanupScheduleJson = {
  enabled: true,
  cron: "0 4 * * *",
  diskPercent: 80,
  images: true,
  buildCache: true,
  stoppedContainers: true,
  unusedVolumes: false,
};

export function stored(row: Pick<typeof nodes.$inferSelect, "cleanupSchedule">): CleanupScheduleJson {
  return { ...defaultSchedule, ...(row.cleanupSchedule ?? {}) };
}

export function toSchedule(json: CleanupScheduleJson): Schedule {
  return {
    enabled: json.enabled,
    cron: json.cron,
    diskPercent: json.diskPercent,
    kinds: {
      images: json.images,
      buildCache: json.buildCache,
      stoppedContainers: json.stoppedContainers,
      unusedVolumes: json.unusedVolumes,
    },
  };
}

export function fromSchedule(s: Schedule): CleanupScheduleJson {
  return {
    enabled: s.enabled,
    // Sunday is stored as 0 (the node's parser does not read 7).
    cron: s.cron === null ? null : normalizeCronSchedule(s.cron.trim().replace(/\s+/g, " ")),
    diskPercent: s.diskPercent,
    images: s.kinds.images,
    buildCache: s.kinds.buildCache,
    stoppedContainers: s.kinds.stoppedContainers,
    unusedVolumes: s.kinds.unusedVolumes,
  };
}

/** Throws BAD_REQUEST for a schedule the node could not run (also syntax only the panel's croner reads, see nodeCronProblem). */
export function checkSchedule(json: CleanupScheduleJson, timeZone: string | null): void {
  if (json.cron !== null) {
    const zone = timeZone && isTimeZone(timeZone) ? timeZone : "UTC";
    const problem = nodeCronProblem(json.cron, zone);
    if (problem) throw new OpError("BAD_REQUEST", `The schedule is not valid: ${problem}.`, { field: "schedule.cron" });
    if (!nextCronRun(json.cron, zone, new Date())) {
      throw new OpError("BAD_REQUEST", "The schedule never fires.", { field: "schedule.cron" });
    }
  }
  if (!json.enabled) return;
  if (json.cron === null && json.diskPercent === null) {
    throw new OpError("BAD_REQUEST", "Pick a schedule, a disk line or both.", { field: "schedule" });
  }
  if (!json.images && !json.buildCache && !json.stoppedContainers && !json.unusedVolumes) {
    throw new OpError("BAD_REQUEST", "Pick at least one thing to clean up.", { field: "schedule.kinds" });
  }
}

/** NodeSettings.cleanup for the node (unset while off, so older agents see nothing new). */
export function toProto(json: CleanupScheduleJson): CleanupSchedule | undefined {
  if (!json.enabled) return undefined;
  return create(CleanupScheduleSchema, {
    enabled: true,
    cron: json.cron === null ? "" : normalizeCronSchedule(json.cron),
    diskPercent: json.diskPercent ?? 0,
    images: json.images,
    buildCache: json.buildCache,
    stoppedContainers: json.stoppedContainers,
    unusedVolumes: json.unusedVolumes,
  });
}

/** The next scheduled run, or null when off, disk-only or the zone is unknown. */
export function nextRun(json: CleanupScheduleJson, timeZone: string | null, now = new Date()): string | null {
  if (!json.enabled || json.cron === null || !timeZone || !isTimeZone(timeZone)) return null;
  try {
    return nextCronRun(json.cron, timeZone, now)?.toISOString() ?? null;
  } catch {
    return null;
  }
}

/** Agents from 0.2 on run scheduled cleanup; dev builds always do. */
export function agentRunsSchedules(agentVersion: string | null | undefined): boolean {
  const v = parseVersion(agentVersion);
  if (!v) return true;
  return v.major > 0 || v.minor >= 2;
}
