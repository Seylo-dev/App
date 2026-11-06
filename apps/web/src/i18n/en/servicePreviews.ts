// English strings: servicePreviews. See ../t.ts for keys, placeholders and plurals.
// The Previews tab.

export default {
  title: "Pull request previews",
  description: "Every open pull request gets its own copy of this service, deployed on each push and removed when the PR closes.",
  unavailable: "Previews are not available for this service",
  githubOnly: "Only services that deploy from GitHub can have previews.",
  toSource: "Change the source",
  enabled: "Previews",
  enabledHint: "Turning them off removes the open previews.",
  sameEnvTitle: "Same environment, same database",
  sameEnvBody:
    "Previews use this service's environment, so they talk to the same database, cache and APIs. Point them at test data if that matters.",
  pattern: "Domain pattern",
  patternHint: "{pr} and {service} are replaced. Empty uses the node's wildcard domain.",
  max: "Most at once",
  maxHint: "The oldest preview goes first.",
  turnOnTitle: "Turn on pull request previews?",
  turnOn: "Turn on",
  acknowledge: "I understand previews share this service's environment",
  ackRequired: "Tick the box first.",
  list: "Previews",
  none: "No previews yet",
  noneHint: "Open a pull request against the deployed branch to get one.",
  closed: "closed {when}",
  open: "Open service",
  delete: "Delete the preview of PR #{pr}",
  deleteTitle: "Delete the preview of PR #{pr}?",
  deleteBody: "Its service, containers and volumes are deleted. The next push to the PR creates it again while previews are on.",
} as const;
