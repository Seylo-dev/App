// English strings: serviceOverview. See ../t.ts for keys, placeholders and plurals.
// The Overview tab of apps, compose stacks, cron services and Boxes.

export default {
  runsOn: "Runs on",
  replicas: { one: "{count} replica", other: "{count} replicas" },
  ports: "Ports",
  portFromEnv: "{port}/tcp, as PORT",
  generation: "Generation",
  quick: "Quick actions",
  deploys: "Deploys",
  allDeploys: "All deploys",
  liveIs: "Live: {version}, deployed {when}",
  lastHour: "Last hour",
  members: "Members",
  membersHint: "Each compose service is its own service with logs, domains and deploys",
  noMembers: "This stack has no members yet",
  noSchedule: "No schedule set. Set one on the Advanced tab.",
  imageDefault: "image default",
  box: {
    title: "Box",
    description: "A code-server workspace on the project network: it reaches this project's services on its node by name.",
    state: "State",
    repository: "Repository",
    sleeps: "Sleeps",
    afterIdle: { one: "after {count} idle minute", other: "after {count} idle minutes" },
    never: "never",
    lastUsed: "Last used",
    states: { running: "Running", starting: "Starting", sleeping: "Sleeping", stopped: "Stopped" },
  },
} as const;
