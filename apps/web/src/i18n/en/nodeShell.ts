// English strings: nodeShell. See ../t.ts for keys, placeholders and plurals.
//
// The Shell view of the node sheet: a root shell on the node itself.

export default {
  tab: "Shell",
  title: "Root shell on {name}",
  subtitle: "A root login shell on the server itself, not in a container",
  offTitle: "Host shells are off for this node",
  offHint:
    "With them on, owners and admins can open a root shell on this server from the panel. Each one needs a recent sign-in, closes after {minutes} minutes without input and shows in the activity log.",
  ownerOnly: "Only the owner can turn them on.",
  enable: "Allow host shells",
  enabled: "Host shells are allowed on {name}",
  disable: "Turn off",
  disabled: "Host shells are off for {name}. Open shells were closed.",
  allowed: "Allowed",
  limits:
    "At most {max} open at a time. Each closes after {minutes} minutes without input or output. You get a security alert when one opens.",
  open: "Open root shell",
  close: "Close shell",
  unavailable: "The node is offline or its agent is too old for host shells.",
  openNow: { one: "{count} open now", other: "{count} open now" },
  openedBy: "{name}, {when}",
  connected: "Connected to {node} as {user} in {workdir}",
  idle: "closes after {minutes} minutes idle",
  confirmTitle: "Allow root shells on {name}?",
  confirmHint:
    "Anyone with the owner or admin role can then run any command as root on this server, after confirming it is them. The agent refuses shells again as soon as you turn this off.",
  loading: "Loading the host shell state",
} as const;
