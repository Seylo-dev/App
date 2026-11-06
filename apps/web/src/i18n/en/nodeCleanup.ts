// English strings: nodeCleanup. See ../t.ts for keys, placeholders and plurals.
//
// The Cleanup view of the node sheet: the schedule the node runs by itself
// and its recent cleanups.

export default {
  tab: "Cleanup",
  schedule: "Scheduled cleanup",
  scheduleHint: "The node cleans up by itself, also while the panel is down. Only what this panel created is ever removed.",
  enabled: "Clean up on its own",
  enabledHint: "Off until you turn it on.",
  onSchedule: "On a schedule",
  cron: "Cron expression",
  cronHint: "Five fields: minute, hour, day, month, weekday. Times are in the node's time zone ({zone}).",
  unknownZone: "not reported yet",
  nextRun: "Next run {when}",
  onDisk: "When a disk is fuller than",
  diskHint:
    "The data and Docker disks are checked every 10 minutes. It runs at most once an hour, and every 6 hours while the disk stays full.",
  percent: "Percent",
  what: "What to remove",
  kinds: {
    images: { name: "Old images", hint: "Past the newest 3 per service; the ones in use always stay" },
    buildCache: { name: "Build cache", hint: "Layers this panel's builders cached" },
    stoppedContainers: { name: "Stopped containers", hint: "Finished jobs, old generations, removed services" },
    unusedVolumes: { name: "Unused volumes", hint: "Data of services removed from this node" },
  },
  volumesWarning: "Unused volumes hold the data of services removed from this node. Once cleaned up it is gone for good.",
  oldAgent: "This node's agent is too old to clean up on its own. Update the node first.",
  save: "Save schedule",
  saved: "Cleanup schedule saved",
  changedElsewhere: "Someone else saved this schedule while you were editing it. Saving now replaces their version.",
  loadSaved: "Load the saved schedule",
  manual: "To clean up right now, use Settings > Docker cleanup.",
  manualLink: "Open Docker cleanup",
  runs: "Recent cleanups",
  freed30d: "{size} freed in the last 30 days",
  noRuns: "No cleanups yet",
  noRunsHint: "Runs on the schedule, on a full disk and from Docker cleanup show up here.",
  trigger: {
    schedule: "Schedule",
    disk: "Disk {percent}%",
    diskUnknown: "Disk",
    manual: "Manual",
    manualBy: "Manual, {name}",
  },
  status: { succeeded: "Done", failed: "Failed" },
  freed: "{size} freed",
  items: { one: "{count} item", other: "{count} items" },
  details: "What it removed",
  moreLines: { one: "and {count} more line", other: "and {count} more lines" },
  loading: "Loading the cleanup schedule",
} as const;
